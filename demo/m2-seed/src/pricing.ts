export type Item = { sku: string; price: number; qty: number };

/** calcTotal: sum of price × quantity over the cart. shippingFee: shipping for the cart, in dollars. */
export function calcTotal(items: Item[]): number { return items.reduce((sum, item) => sum + item.price * item.qty, 0); }
export function shippingFee(items: Item[]): number { return items.length ? 5 : 0; }
