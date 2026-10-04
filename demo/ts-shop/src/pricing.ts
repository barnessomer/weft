export type Item = { sku: string; price: number; qty: number };

/** Sum of price × quantity over the cart. */
export function calcTotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
