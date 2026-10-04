/** Catalog prices per kg (Weft demo). */
export const PRICES: Record<string, number> = {
  apple: 1,
  pear: 2,
};

export function priceOf(sku: string): number {
  const p = PRICES[sku];
  if (p === undefined) throw new Error(`unknown sku ${sku}`);
  return p;
}
