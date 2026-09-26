// Tools the AI receptionist can call. They use the same rules as the admin "New booking" form,
// so the AI never does its own maths and bookings behave exactly like staff-created ones.
const Booking = require("../models/Booking");
const Service = require("../models/Service");

const FREQUENCIES = ["Once", "Weekly", "Fortnightly", "Monthly", "Quarterly", "Yearly"];
// Same slots and cut-off hours as the admin form (a slot can't be booked on the day after its limit).
const SLOTS = [
  { value: "Morning", label: "8am–12pm", limit: 12 },
  { value: "Afternoon", label: "12pm–4pm", limit: 16 },
  { value: "Evening", label: "4pm–8pm", limit: 20 },
];
const ACTIVE_STATUSES = ["Confirmed", "Pending", "Accepted", "In Progress"];
const MAX_AI_BOOKINGS_PER_PHONE_PER_DAY = 2;

const clean = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const money = (n) => Math.round(n * 100) / 100;

// ── Pricing (mirrors NewBookingPage.jsx: base hourly rate × hours + extras × qty) ──────────
async function loadUkServices() {
  return Service.find({ region: "UK", rate: { $gt: 0 } }).lean();
}

function calculateQuote(services, { service, hours, extras = [] }) {
  const hourly = services.filter((s) => s.type === "hourly");
  const base = hourly.find((s) => clean(s.name) === clean(service));
  if (!base) {
    return { error: `Unknown service "${service}". Choose one of: ${hourly.map((s) => s.name).join(", ")}` };
  }
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 1 || h > 50) return { error: "Hours must be between 1 and 50." };

  const extraOptions = services.filter((s) => s.type !== "hourly" && s.type !== "per_room" && s.category !== "Rooms");
  const lines = [];
  for (const ex of extras || []) {
    const match = extraOptions.find((s) => clean(s.name) === clean(ex.name));
    if (!match) {
      return { error: `Unknown extra "${ex.name}". Available extras: ${extraOptions.map((s) => s.name).join(", ")}` };
    }
    const qty = Math.max(1, Math.round(Number(ex.qty) || 1));
    lines.push({ name: match.name, unitPrice: match.rate, qty, subtotal: money(match.rate * qty) });
  }
  const labour = money(base.rate * h);
  const total = money(labour + lines.reduce((sum, l) => sum + l.subtotal, 0));
  return {
    service: base.name,
    hourlyRate: base.rate,
    hours: h,
    labour,
    extras: lines,
    total,
    currency: "GBP",
  };
}

// ── Availability (same rule as the admin form: a slot is taken if a booking already uses it) ──
function londonNowParts(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

async function getAvailability(date, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return { error: "Date must be in YYYY-MM-DD format." };
  const today = londonNowParts(now);
  if (date < today.date) return { error: "That date is in the past." };

  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const bookings = await Booking.find({
    "schedule.date": { $gte: dayStart, $lt: dayEnd },
    status: { $in: ACTIVE_STATUSES },
  }).select("schedule.timeSlot").lean();
  const taken = bookings.map((b) => b.schedule?.timeSlot || "");

  let slots = SLOTS;
  if (date === today.date) {
    const effHour = today.minute >= 30 ? today.hour + 1 : today.hour;
    slots = slots.filter((s) => effHour < s.limit);
  }
  const available = slots.filter((s) => !taken.some((t) => t.includes(s.value)));
  return {
    date,
    weekday: new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }),
    availableSlots: available.map((s) => `${s.value} (${s.label})`),
    fullyBooked: available.length === 0,
  };
}

// ── Booking (same payload as the admin form's handleSubmit) ─────────────────────────────
const NAME_RE = /^[A-Za-z][A-Za-z' -]+$/;
// UK postcode, e.g. M1 1AA, M14 5TQ, SW1A 1AA
const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const findPostcode = (text) => {
  const m = String(text || "").match(POSTCODE_RE);
  return m ? `${m[1]} ${m[2]}`.toUpperCase() : "";
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function uniqueBookingId() {
  for (let i = 0; i < 20; i++) {
    const id = `BK-${Math.floor(1000 + Math.random() * 9000)}`;
    if (!(await Booking.exists({ bookingId: id }))) return id;
  }
  return `BK-${Date.now().toString().slice(-6)}`;
}

async function createAiBooking(args, ctx) {
  const postcode = findPostcode(args.postcode) || findPostcode(args.address);
  const problems = [];
  if (!args.customerConfirmed) problems.push("the customer has not explicitly confirmed the summary and price yet");
  if (!NAME_RE.test(args.firstName || "") || args.firstName.trim().length < 2) problems.push("first name (letters only)");
  if (!NAME_RE.test(args.lastName || "") || args.lastName.trim().length < 2) problems.push("last name (letters only)");
  if (!EMAIL_RE.test(args.email || "")) problems.push("a valid email address");
  if (!args.address || args.address.trim().length < 5) problems.push("the full address");
  if (!postcode) problems.push("a valid UK postcode");
  if (!SLOTS.some((s) => s.value === args.timeSlot) && args.timeSlot !== "Flexible") problems.push("a time slot");
  if (args.timeSlot === "Flexible" && !args.preferredTime) problems.push("the preferred time for a flexible slot");
  const frequency = FREQUENCIES.includes(args.frequency) ? args.frequency : "Once";
  if (problems.length) return { error: `Cannot book yet. Still needed: ${problems.join("; ")}.` };

  const recent = await Booking.countDocuments({
    "customer.phone": ctx.phone,
    leadSource: "WhatsApp AI",
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
  if (recent >= MAX_AI_BOOKINGS_PER_PHONE_PER_DAY) {
    return { error: "This customer already has recent bookings from this chat. Offer to pass the request to the team instead." };
  }

  const availability = await getAvailability(args.date);
  if (availability.error) return availability;
  if (args.timeSlot !== "Flexible" && !availability.availableSlots.some((s) => s.startsWith(args.timeSlot))) {
    return { error: `${args.timeSlot} is not available on ${args.date}. Available: ${availability.availableSlots.join(", ") || "none"}.` };
  }

  const quote = calculateQuote(await loadUkServices(), args);
  if (quote.error) return quote;

  const payload = {
    bookingId: await uniqueBookingId(),
    customer: {
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      email: args.email.trim().toLowerCase(),
      phone: ctx.phone,
    },
    service: quote.service,
    details: {
      address: args.address.trim(),
      postcode,
      frequency,
      duration: quote.hours,
      extras: quote.extras.map((e) => ({ name: e.name, qty: e.qty, rate: e.unitPrice })),
      Bedroom: Number(args.bedrooms) || 0,
      Bathroom: Number(args.bathrooms) || 0,
      Kitchen: 0,
      "Living Room": 0,
      "Utility Room": 0,
      "Reception Room": 0,
      Conservatory: 0,
      Cloakroom: 0,
      hasPet: args.hasPet ? "Yes" : "No",
    },
    schedule: {
      date: args.date,
      timeSlot: args.timeSlot,
      preferredTime: args.timeSlot === "Flexible" ? args.preferredTime : "",
    },
    payment: { amount: quote.total, currency: "GBP", status: "Pending", billingType: "hourly" },
    status: "Pending",
    leadSource: "WhatsApp AI",
    suppliesProvidedBy: "Cleaniq",
    notes: args.notes || "",
    noPaymentRequired: false,
    skipConfirmationEmail: false,
    createdByAdmin: null,
    meta: { coupon: null, source: "ai-receptionist", conversationId: ctx.conversationId || null },
  };

  if (ctx.dryRun) return { dryRun: true, message: "TEST MODE: booking not saved.", bookingRef: payload.bookingId, total: quote.total };

  const { createBooking } = require("../routes/bookings");
  const booking = await createBooking(payload);
  console.log(`[ai-tools] booking ${booking.bookingId} created from WhatsApp ${ctx.phone} (£${quote.total})`);
  return {
    bookingRef: booking.bookingId,
    status: "Pending",
    total: quote.total,
    nextStep: `A confirmation email with a secure payment link has been sent to ${payload.customer.email}. The booking is confirmed once payment is completed.`,
  };
}

// ── Declarations for the model ──────────────────────────────────────────────────────────
const extrasSchema = {
  type: "array",
  description: "Optional add-on extras, using names exactly as listed under 'Add-on extras'.",
  items: {
    type: "object",
    properties: { name: { type: "string" }, qty: { type: "integer", minimum: 1 } },
    required: ["name"],
  },
};

const declarations = [
  {
    name: "get_quote",
    description:
      "Calculate the exact price for a cleaning job using the business's live prices. Always use this for any total; never add up prices yourself.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Cleaning service name exactly as listed under 'Cleaning services'." },
        hours: { type: "number", description: "Number of hours (1–50)." },
        extras: extrasSchema,
      },
      required: ["service", "hours"],
    },
  },
  {
    name: "check_availability",
    description: "Check which time slots are free on a date. Use before offering or booking a date.",
    parametersJsonSchema: {
      type: "object",
      properties: { date: { type: "string", description: "Date in YYYY-MM-DD format (UK)." } },
      required: ["date"],
    },
  },
  {
    name: "create_booking",
    description:
      "Create the booking in the system, exactly like staff do. Only call after showing the customer a summary with the total from get_quote and receiving an explicit yes.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        email: { type: "string" },
        service: { type: "string" },
        hours: { type: "number" },
        extras: extrasSchema,
        date: { type: "string", description: "YYYY-MM-DD" },
        timeSlot: { type: "string", enum: ["Morning", "Afternoon", "Evening", "Flexible"] },
        preferredTime: { type: "string", description: "Only for Flexible, e.g. 10:30am" },
        address: { type: "string", description: "Street address including house/flat number and town" },
        postcode: { type: "string", description: "Optional if the address already includes the postcode" },
        frequency: { type: "string", enum: FREQUENCIES },
        bedrooms: { type: "integer" },
        bathrooms: { type: "integer" },
        hasPet: { type: "boolean" },
        notes: { type: "string", description: "Access instructions or special requests" },
        customerConfirmed: { type: "boolean", description: "True only if the customer explicitly said yes to the summary and total." },
      },
      required: ["firstName", "lastName", "email", "service", "hours", "date", "timeSlot", "address", "customerConfirmed"],
    },
  },
];

/** Returns a runner bound to one conversation. ctx: { phone, conversationId, dryRun } */
function makeToolRunner(ctx) {
  return async function runTool(name, args = {}) {
    try {
      if (name === "get_quote") return calculateQuote(await loadUkServices(), args);
      if (name === "check_availability") return await getAvailability(args.date);
      if (name === "create_booking") return await createAiBooking(args, ctx);
      return { error: `Unknown tool ${name}` };
    } catch (err) {
      console.error(`[ai-tools] ${name} failed:`, err);
      return { error: "The booking system had a problem. Offer to pass the request to the team." };
    }
  };
}

module.exports = { declarations, makeToolRunner, calculateQuote, getAvailability, createAiBooking, SLOTS };
