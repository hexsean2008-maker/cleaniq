const test = require("node:test");
const assert = require("node:assert/strict");
const { buildInstructions } = require("../utils/aiBrain");
const { toE164UK } = require("../utils/phone");

const settings = {
  businessName: "Cleaniq Services",
  serviceArea: "Manchester and Greater Manchester, UK",
  instructions: "Be warm and professional.",
  transferNumber: "+447700900123",
};
const services = [
  { name: "Deep Clean", rate: 24.9, type: "hourly", category: "Base", description: "Thorough deep clean" },
  { name: "Single Oven Cleaning", rate: 15, type: "flat", category: "Extras" },
  { name: "Bedroom", rate: 12, type: "per_room", category: "Rooms" },
];
const knowledge = [{ title: "Opening hours", category: "Hours", content: "Mon–Sat 8am–6pm." }];
const now = new Date("2026-09-26T10:00:00Z");

test("includes live prices in pounds; rooms are not listed as a charge", () => {
  const p = buildInstructions({ channel: "whatsapp", settings, knowledge, services, now });
  assert.match(p, /Deep Clean: £24\.90 per hour \(Thorough deep clean\)/);
  assert.match(p, /Single Oven Cleaning: £15\.00 fixed price/);
  assert.doesNotMatch(p, /Bedroom: £/);
  assert.match(p, /Rooms \(bedrooms, bathrooms, etc\.\) are not charged separately/);
});

test("forbids made-up hour estimates on every channel", () => {
  for (const channel of ["whatsapp", "voice"]) {
    const p = buildInstructions({ channel, settings, knowledge, services, now });
    assert.match(p, /Never state typical, average or estimated hours/);
  }
});

test("booking rules only when the channel can book", () => {
  const withTools = buildInstructions({ channel: "whatsapp", settings, knowledge, services, now, canBook: true });
  assert.match(withTools, /call get_quote/);
  assert.match(withTools, /create_booking with customerConfirmed true/);
  assert.match(withTools, /ask for ALL missing required details in ONE message/);
  assert.match(withTools, /Do not ask for bedrooms, bathrooms, pets or access notes/);
  assert.match(withTools, /Never ask one question per message/);
  assert.match(withTools, /Example of the pattern to follow/);
  // the short-reply rule must not fight the booking list
  assert.match(withTools, /Exception: when collecting booking details or sending a booking summary, use a short numbered list/);
  const without = buildInstructions({ channel: "voice", settings, knowledge, services, now });
  assert.doesNotMatch(without, /create_booking/);
  assert.match(without, /You cannot confirm bookings/);
});

test("includes knowledge, staff instructions and UK time", () => {
  const p = buildInstructions({ channel: "whatsapp", settings, knowledge, services, now });
  assert.match(p, /### Opening hours \[Hours\]\nMon–Sat 8am–6pm\./);
  assert.match(p, /Be warm and professional\./);
  assert.match(p, /Saturday, 26 September 2026/);
  assert.match(p, /at 11:00/); // 10:00 UTC = 11:00 BST
});

test("voice prompt discloses AI + transcription and uses the transfer tool when a number is set", () => {
  const p = buildInstructions({ channel: "voice", settings, knowledge, services, now });
  assert.match(p, /AI assistant, and mention the call is transcribed/);
  assert.match(p, /transfer_to_human/);
  assert.match(p, /1–3 short spoken sentences/);
});

test("voice prompt falls back to a callback when no transfer number is set", () => {
  const p = buildInstructions({ channel: "voice", settings: { ...settings, transferNumber: "" }, knowledge, services, now });
  assert.doesNotMatch(p, /transfer_to_human/);
  assert.match(p, /call them back/);
});

test("handles an empty knowledge base and no prices", () => {
  const p = buildInstructions({ channel: "whatsapp", settings, knowledge: [], services: [], now });
  assert.match(p, /No extra business information has been added yet/);
  assert.match(p, /No prices are currently listed/);
});

test("rejects unknown channels", () => {
  assert.throws(() => buildInstructions({ channel: "sms", settings, knowledge, services }), /Unknown channel/);
});

test("normalises UK phone numbers to E.164", () => {
  assert.equal(toE164UK("07700 900123"), "+447700900123");
  assert.equal(toE164UK("447700900123"), "+447700900123");
  assert.equal(toE164UK("+44 7700 900-123"), "+447700900123");
  assert.equal(toE164UK("0044 7700 900123"), "+447700900123");
  assert.equal(toE164UK("0161 496 0000"), "+441614960000");
  assert.equal(toE164UK("hello"), "");
  assert.equal(toE164UK(""), "");
});
