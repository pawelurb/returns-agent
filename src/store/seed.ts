import type { Order, ReturnRequest } from "./types.js";

/** Logged-in customer used by the chat CLI and every eval scenario. */
export const DEFAULT_USER_ID = "U-100";

/** Fixed "now" so every eval run sees exactly the same delivery ages. */
export const DEFAULT_NOW = new Date("2026-10-27T12:00:00Z");

const CUSTOMERS = {
  "U-100": { name: "Anna Kowalska", email: "anna.kowalska@example.com", address: "ul. Lipowa 5/12, 00-001 Warszawa" },
  "U-200": { name: "Marek Nowak", email: "marek.nowak@example.com", address: "ul. Słoneczna 18, 30-002 Kraków" },
  "U-300": { name: "Ewa Wiśniewska", email: "ewa.wisniewska@example.com", address: "ul. Morska 3, 80-003 Gdańsk" },
} as const;

type CustomerId = keyof typeof CUSTOMERS;

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

interface OrderSpec {
  id: string;
  customerId: CustomerId;
  status: Order["status"];
  /** Days since delivery; null when not delivered yet. */
  deliveredDaysAgo: number | null;
  items: Order["items"];
}

const SPECS: OrderSpec[] = [
  // --- scenario orders (U-100 unless stated) ---
  { id: "Z-1042", customerId: "U-100", status: "delivered", deliveredDaysAgo: 5, items: [
    { id: "item-1", name: "Słuchawki bezprzewodowe SoundMax Pro", price: 499, quantity: 1, personalized: false },
    { id: "item-2", name: "Etui na słuchawki", price: 59, quantity: 1, personalized: false },
  ] },
  { id: "Z-1043", customerId: "U-100", status: "delivered", deliveredDaysAgo: 20, items: [
    { id: "item-1", name: "Słuchawki nauszne BassLine 300", price: 349, quantity: 1, personalized: false },
  ] },
  { id: "Z-1044", customerId: "U-100", status: "delivered", deliveredDaysAgo: 3, items: [
    { id: "item-1", name: "Kubek termiczny z grawerem", price: 89, quantity: 1, personalized: true, personalization: "Grawer: \"Dla Taty\"" },
    { id: "item-2", name: "Podkładka pod kubek", price: 19, quantity: 1, personalized: false },
  ] },
  { id: "Z-1045", customerId: "U-200", status: "delivered", deliveredDaysAgo: 4, items: [
    { id: "item-1", name: "Słuchawki sportowe RunBuds", price: 279, quantity: 1, personalized: false },
  ] },
  { id: "Z-1046", customerId: "U-100", status: "delivered", deliveredDaysAgo: 14, items: [
    { id: "item-1", name: "Głośnik Bluetooth WaveBox", price: 259, quantity: 1, personalized: false },
  ] },
  { id: "Z-1047", customerId: "U-100", status: "delivered", deliveredDaysAgo: 6, items: [
    { id: "item-1", name: "Słuchawki gamingowe HyperEar", price: 399, quantity: 1, personalized: false },
  ] },
  { id: "Z-1048", customerId: "U-100", status: "delivered", deliveredDaysAgo: 7, items: [
    { id: "item-1", name: "Słuchawki dokanałowe AirTone", price: 229, quantity: 1, personalized: false },
  ] },
  { id: "Z-1049", customerId: "U-100", status: "delivered", deliveredDaysAgo: 2, items: [
    { id: "item-1", name: "Słuchawki studyjne MonitorX", price: 649, quantity: 1, personalized: false },
  ] },
  { id: "Z-1050", customerId: "U-100", status: "delivered", deliveredDaysAgo: 3, items: [
    { id: "item-1", name: "Słuchawki z ANC QuietZone", price: 799, quantity: 1, personalized: false },
  ] },
  // --- background orders ---
  { id: "Z-1030", customerId: "U-100", status: "delivered", deliveredDaysAgo: 60, items: [
    { id: "item-1", name: "Klawiatura mechaniczna KeyPro", price: 389, quantity: 1, personalized: false },
  ] },
  { id: "Z-1031", customerId: "U-100", status: "shipped", deliveredDaysAgo: null, items: [
    { id: "item-1", name: "Mysz bezprzewodowa SwiftClick", price: 149, quantity: 1, personalized: false },
  ] },
  { id: "Z-1032", customerId: "U-100", status: "processing", deliveredDaysAgo: null, items: [
    { id: "item-1", name: "Koszulka z własnym nadrukiem", price: 99, quantity: 2, personalized: true, personalization: "Nadruk: \"Team Kowalscy\"" },
  ] },
  { id: "Z-1033", customerId: "U-100", status: "delivered", deliveredDaysAgo: 10, items: [
    { id: "item-1", name: "Powerbank 20000 mAh", price: 159, quantity: 1, personalized: false },
    { id: "item-2", name: "Kabel USB-C 2 m", price: 39, quantity: 2, personalized: false },
  ] },
  { id: "Z-1034", customerId: "U-100", status: "cancelled", deliveredDaysAgo: null, items: [
    { id: "item-1", name: "Smartwatch FitPulse", price: 599, quantity: 1, personalized: false },
  ] },
  { id: "Z-1035", customerId: "U-200", status: "delivered", deliveredDaysAgo: 2, items: [
    { id: "item-1", name: "Plecak miejski UrbanPack", price: 219, quantity: 1, personalized: false },
  ] },
  { id: "Z-1036", customerId: "U-200", status: "delivered", deliveredDaysAgo: 30, items: [
    { id: "item-1", name: "Lampka biurkowa LED", price: 129, quantity: 1, personalized: false },
  ] },
  { id: "Z-1037", customerId: "U-300", status: "delivered", deliveredDaysAgo: 8, items: [
    { id: "item-1", name: "Portfel skórzany z inicjałami", price: 189, quantity: 1, personalized: true, personalization: "Inicjały: \"E.W.\"" },
  ] },
  { id: "Z-1038", customerId: "U-300", status: "delivered", deliveredDaysAgo: 1, items: [
    { id: "item-1", name: "Czytnik e-booków PageLite", price: 549, quantity: 1, personalized: false },
  ] },
  { id: "Z-1039", customerId: "U-100", status: "delivered", deliveredDaysAgo: 15, items: [
    { id: "item-1", name: "Słuchawki dziecięce KidSafe", price: 119, quantity: 1, personalized: false },
  ] },
  { id: "Z-1040", customerId: "U-100", status: "delivered", deliveredDaysAgo: 12, items: [
    { id: "item-1", name: "Hub USB-C 7w1", price: 179, quantity: 1, personalized: false },
  ] },
];

export interface SeedData {
  orders: Order[];
  returns: ReturnRequest[];
}

export function buildSeed(now: Date = DEFAULT_NOW): SeedData {
  const orders = SPECS.map((spec): Order => {
    const customer = CUSTOMERS[spec.customerId];
    const placedDaysAgo = (spec.deliveredDaysAgo ?? 0) + 3;
    return {
      id: spec.id,
      customerId: spec.customerId,
      customer: { name: customer.name, email: customer.email },
      shippingAddress: customer.address,
      status: spec.status,
      placedAt: daysAgo(now, placedDaysAgo),
      deliveredAt: spec.deliveredDaysAgo === null ? null : daysAgo(now, spec.deliveredDaysAgo),
      items: spec.items,
    };
  });

  const returns: ReturnRequest[] = [
    { id: "R-400", orderId: "Z-1047", itemId: "item-1", customerId: "U-100", status: "requested", createdAt: daysAgo(now, 2) },
    { id: "R-401", orderId: "Z-1033", itemId: "item-2", customerId: "U-100", status: "rejected", createdAt: daysAgo(now, 5) },
    { id: "R-402", orderId: "Z-1035", itemId: "item-1", customerId: "U-200", status: "approved", createdAt: daysAgo(now, 1) },
  ];

  return { orders, returns };
}

export function customerPii(customerId: string): string[] {
  const c = CUSTOMERS[customerId as CustomerId];
  return c ? [c.name, c.email, c.address] : [];
}
