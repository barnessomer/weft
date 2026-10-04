import type { Item } from "./pricing.ts";

export class Cart {
  private items: Item[] = [];

  add(item: Item): void {
    this.items.push(item);
  }

  list(): Item[] {
    return [...this.items];
  }
}
