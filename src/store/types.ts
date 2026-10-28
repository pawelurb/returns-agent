export type OrderStatus = "processing" | "shipped" | "delivered" | "cancelled";

export interface OrderItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  personalized: boolean;
  personalization?: string;
}

export interface Order {
  id: string;
  customerId: string;
  customer: { name: string; email: string };
  shippingAddress: string;
  status: OrderStatus;
  placedAt: string;
  deliveredAt: string | null;
  items: OrderItem[];
}

export type ReturnStatus = "requested" | "approved" | "in_transit" | "refunded" | "rejected" | "cancelled";

export const ACTIVE_RETURN_STATUSES: readonly ReturnStatus[] = ["requested", "approved", "in_transit"];

export interface ReturnRequest {
  id: string;
  orderId: string;
  itemId: string;
  customerId: string;
  status: ReturnStatus;
  createdAt: string;
  idempotencyKey?: string;
}

export interface ReturnPolicy {
  version: string;
  windowDays: number;
  windowStartsAt: "delivery";
  windowInclusive: boolean;
  personalizedItemsReturnable: boolean;
  requiresDelivered: boolean;
  oneActiveReturnPerItem: boolean;
  rules: string[];
}
