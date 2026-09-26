// WhatsApp channel of the AI receptionist, via Twilio.
// Incoming message → save → (if AI is on for this chat) build instructions → AI reply → send via Twilio.
const AiSettings = require("../models/AiSettings");
const AiConversation = require("../models/AiConversation");
const AiMessage = require("../models/AiMessage");
const SystemSetting = require("../models/SystemSetting");
const { getInstructions } = require("./aiBrain");
const { generateReply } = require("./aiProvider");
const { declarations: bookingTools, makeToolRunner } = require("./aiTools");
const { toE164UK, findCustomerByPhone } = require("./phone");

const HISTORY_LIMIT = 20;
const MAX_AI_REPLIES_PER_HOUR = 30; // per conversation — protects the AI quota from spam/loops
// Across all chats; protects prepaid AI credit. Override with AI_DAILY_REPLY_LIMIT in .env.
const dailyReplyLimit = () => Number(process.env.AI_DAILY_REPLY_LIMIT) || 200;
const HANDOFF_TEXT = "Thanks for your message! A member of our team will reply here as soon as possible.";
const AI_ERROR_TEXT = "Sorry, I'm having a technical issue right now. Please try again in a few minutes, or a member of our team will reply here soon.";
const TEXT_ONLY_TEXT = "Sorry, I can only read text messages at the moment. Could you type your question?";

// Same lookup as the SMS service: admin-entered SystemSetting first, then .env.
async function getTwilioCredentials() {
  const [sid, token] = await Promise.all([
    SystemSetting.findOne({ key: "twilio_account_sid" }),
    SystemSetting.findOne({ key: "twilio_auth_token" }),
  ]);
  return {
    sid: sid?.value || process.env.TWILIO_ACCOUNT_SID || "",
    token: token?.value || process.env.TWILIO_AUTH_TOKEN || "",
  };
}

// Twilio sends "whatsapp:+447700900123"; we store "+447700900123".
const fromWhatsAppAddress = (addr) => toE164UK(String(addr || "").replace(/^whatsapp:/, ""));

async function sendWhatsApp(to, body) {
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!from) throw new Error("TWILIO_WHATSAPP_FROM is not set in server/.env");
  const { sid, token } = await getTwilioCredentials();
  if (!sid || !token) throw new Error("Twilio credentials are not configured");
  const client = require("twilio")(sid, token);
  const msg = await client.messages.create({
    from: from.startsWith("whatsapp:") ? from : `whatsapp:${from}`,
    to: `whatsapp:${to}`,
    body,
  });
  return msg.sid;
}

// Saves our outgoing message and sends it. Never throws: a failed send is recorded on the message.
async function sendAndRecord(conversation, role, text, { send = sendWhatsApp } = {}) {
  const message = await AiMessage.create({ conversation: conversation._id, role, text });
  try {
    await send(conversation.phone, text);
    message.deliveryStatus = "sent";
  } catch (err) {
    console.error(`[whatsapp] send to ${conversation.phone} failed:`, err.message);
    message.deliveryStatus = "failed";
    message.error = err.message.slice(0, 500);
  }
  await message.save();
  await AiConversation.updateOne(
    { _id: conversation._id },
    { $set: { lastMessageAt: new Date(), lastMessagePreview: text.slice(0, 120) } },
  );
  return message;
}

// One reply at a time per conversation. If more customer messages arrive while the AI is
// thinking, they're answered together in one follow-up reply instead of one reply each.
const busy = new Map(); // conversationId -> { again: boolean }

async function replyWithAi(conversationId, deps = {}) {
  const key = String(conversationId);
  if (busy.has(key)) {
    busy.get(key).again = true;
    return;
  }
  busy.set(key, { again: false });
  try {
    do {
      busy.get(key).again = false;
      await replyOnce(conversationId, deps);
    } while (busy.get(key).again);
  } finally {
    busy.delete(key);
  }
}

async function replyOnce(conversationId, { ai = generateReply, send = sendWhatsApp } = {}) {
  const conversation = await AiConversation.findById(conversationId);
  if (!conversation || conversation.status !== "ai") return; // staff took over meanwhile

  const recentAiReplies = await AiMessage.countDocuments({
    conversation: conversation._id,
    role: "ai",
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
  });
  if (recentAiReplies >= MAX_AI_REPLIES_PER_HOUR) {
    console.warn(`[whatsapp] AI reply limit reached for ${conversation.phone}; handing to staff`);
    await AiConversation.updateOne({ _id: conversation._id }, { $set: { status: "human", needsAttention: true } });
    await sendAndRecord(conversation, "ai", HANDOFF_TEXT, { send });
    return;
  }

  const repliesToday = await AiMessage.countDocuments({
    role: "ai",
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
  if (repliesToday >= dailyReplyLimit()) {
    console.warn(`[whatsapp] daily AI reply limit (${dailyReplyLimit()}) reached; handing ${conversation.phone} to staff`);
    await AiConversation.updateOne({ _id: conversation._id }, { $set: { needsAttention: true } });
    await sendAndRecord(conversation, "ai", HANDOFF_TEXT, { send });
    return;
  }

  const history = (
    await AiMessage.find({ conversation: conversation._id }).sort({ createdAt: -1 }).limit(HISTORY_LIMIT).lean()
  ).reverse();
  // Nothing new to answer (e.g. a burst of messages was already covered by the previous reply).
  if (!history.length || history[history.length - 1].role !== "customer") return;

  let reply = null;
  try {
    const system = await getInstructions("whatsapp", { customerName: conversation.name, canBook: true });
    reply = await ai({
      system,
      history,
      tools: bookingTools,
      runTool: makeToolRunner({ phone: conversation.phone, conversationId: String(conversation._id) }),
    });
  } catch (err) {
    console.error(`[whatsapp] AI failed for ${conversation.phone}:`, err.message);
  }
  if (!reply) {
    // AI unavailable or gave nothing: apologise and flag the chat for staff, but keep the AI on
    // so the customer's next message is answered once the provider recovers.
    await AiConversation.updateOne({ _id: conversation._id }, { $set: { needsAttention: true } });
    await sendAndRecord(conversation, "ai", AI_ERROR_TEXT, { send });
    return;
  }
  await sendAndRecord(conversation, "ai", reply, { send });
}

/**
 * Handle one incoming Twilio WhatsApp webhook (already signature-checked).
 * @returns {Promise<{conversationId?: string, action: string}>}
 */
async function handleIncoming(params, deps = {}) {
  const phone = fromWhatsAppAddress(params.From);
  const messageSid = params.MessageSid || params.SmsMessageSid;
  if (!phone || !messageSid) return { action: "ignored-invalid" };

  const body = String(params.Body || "").trim();
  const hasMedia = Number(params.NumMedia || 0) > 0;
  const now = new Date();

  let conversation = await AiConversation.findOne({ phone, channel: "whatsapp" });
  if (!conversation) {
    const customer = await findCustomerByPhone(phone).catch(() => null);
    conversation = await AiConversation.findOneAndUpdate(
      { phone, channel: "whatsapp" },
      {
        $setOnInsert: {
          phone,
          channel: "whatsapp",
          name: params.ProfileName || (customer ? `${customer.firstName} ${customer.lastName}`.trim() : ""),
          customer: customer?._id || null,
        },
      },
      { upsert: true, new: true },
    );
  }

  // Twilio can retry a webhook: the unique whatsappMessageId makes a repeat a no-op.
  try {
    await AiMessage.create({
      conversation: conversation._id,
      role: "customer",
      text: body || (hasMedia ? "[media message]" : "[empty message]"),
      whatsappMessageId: messageSid,
    });
  } catch (err) {
    if (err.code === 11000) return { conversationId: String(conversation._id), action: "duplicate" };
    throw err;
  }

  const update = {
    $set: { lastCustomerMessageAt: now, lastMessageAt: now, lastMessagePreview: (body || "[media]").slice(0, 120) },
    $inc: { unreadCount: 1 },
  };
  if (conversation.status === "closed") update.$set.status = "ai"; // customer came back
  conversation = await AiConversation.findOneAndUpdate({ _id: conversation._id }, update, { new: true });

  const settings = await AiSettings.get();
  if (!settings.whatsappEnabled) return { conversationId: String(conversation._id), action: "saved-ai-off" };
  if (conversation.status !== "ai") return { conversationId: String(conversation._id), action: "saved-human" };

  if (!body) {
    await sendAndRecord(conversation, "ai", TEXT_ONLY_TEXT, deps);
    return { conversationId: String(conversation._id), action: "text-only-notice" };
  }

  await replyWithAi(conversation._id, deps);
  return { conversationId: String(conversation._id), action: "ai-replied" };
}

module.exports = { handleIncoming, sendWhatsApp, sendAndRecord, getTwilioCredentials, fromWhatsAppAddress };
