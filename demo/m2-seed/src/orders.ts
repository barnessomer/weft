import { calcTotal, shippingFee, type Item } from "./pricing.ts";

export type Order = { id: string; items: Item[]; total: number };

export function createOrder(id: string, items: Item[]): Order {
  return { id, items, total: calcTotal(items) + shippingFee(items) };
}
