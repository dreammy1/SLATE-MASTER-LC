/**
 * Order repository — customer purchases and their provisioning progress.
 *
 * `create` initialises `progressPercent`/`progressStage` because every order
 * must start at a known progress state; leaving that to callers meant a new code
 * path could forget it and the tracking UI would render `undefined`.
 */

import type { Order } from "../models";
import { CollectionRepository } from "./baseRepository";

export type NewOrder = Omit<Order, "id" | "createdAt" | "progressPercent" | "progressStage"> & { id?: string };

class OrderRepository extends CollectionRepository<"orders", Order> {
  constructor() {
    super("orders", "ord");
  }

  async create(data: NewOrder): Promise<Order> {
    const record: Order = {
      ...(data as Order),
      id: data.id || this.generateId(),
      progressPercent: 0,
      progressStage: "QUEUED",
      createdAt: new Date().toISOString(),
    };
    return this.add(record);
  }

  /** Always refreshes `updatedAt`, so the tracking page can poll for changes. */
  async patch(id: string, changes: Partial<Order>): Promise<Order | null> {
    const updated = await this.update(id, changes);
    if (!updated) return null;

    // `update` already merged and persisted; stamp the change clock and persist
    // once more so the stored row carries it.
    return this.update(id, { updatedAt: new Date().toISOString() });
  }
}

export const orderRepository = new OrderRepository();