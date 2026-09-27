import { NextRequest, NextResponse } from "next/server";
import { listClients, type ClientRecord } from "@/lib/clientRegistry";

/**
 * Client management API.
 *
 * GET /api/clients            -> every customer (order-first, unlinked sites too)
 * GET /api/clients?q=acme     -> free-text search over name/email/site/package/key
 * GET /api/clients?status=... -> focused work queues (groups below)
 *
 * A "client" aggregates an order + license + live site, so this single endpoint
 * powers the whole /licenses console.
 */

const GROUPS: Record<string, (c: ClientRecord) => boolean> = {
  all: () => true,
  active: (c) => c.license.effective === "active",
  expiring: (c) => c.license.expiringSoon,
  expired: (c) => c.license.effective === "expired",
  unpaid: (c) => c.paymentStatus === "pending_payment" || c.paymentStatus === "pending_review",
  failed: (c) => c.paymentStatus === "failed",
  completed: (c) => c.paymentStatus === "completed",
  readonly: (c) => c.remoteAccess === "readonly",
  unlinked: (c) => c.license.effective === "none" || c.paymentStatus === "unlinked",
};

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q") || undefined;
    const status = (searchParams.get("status") || "all").toLowerCase();

    const { clients, totals } = await listClients(q);
    const predicate = GROUPS[status] || GROUPS.all;
    const filtered = clients.filter(predicate);

    return NextResponse.json({
      success: true,
      count: filtered.length,
      totals,
      groups: Object.keys(GROUPS),
      clients: filtered,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Could not load clients." }, { status: 500 });
  }
}
