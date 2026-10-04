import { NextRequest, NextResponse } from "next/server";
import { getOrder } from "@/lib/storage";
import {
  decryptCpanelToken,
  cpanelUapiCall,
  cpanelAccountPrefix,
} from "@/lib/cpanel";
import { readCpanelHealth } from "@/lib/cpanelHealth";

/**
 * GET /api/orders/[id]/cpanel-health
 *
 * Returns the cPanel account resource panel ("Statistics") for an order:
 * Databases, Email Accounts, File Usage, Disk Usage, Database Disk Usage, CPU,
 * Memory, IOPS, I/O and process counts — exactly the numbers a client sees in
 * cPanel -> Dashboard.
 *
 * The order's stored before/after snapshots are included when they exist, so
 * the console can show what the automation changed next to a live reading.
 *
 * The cPanel token is never returned. If the account is not linked yet, the
 * stored snapshots are still served so the page is never empty.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const id = (await ctx.params).id;

  try {
    const order = await getOrder(id);
    if (!order)
      return NextResponse.json(
        { success: false, error: "Order not found." },
        { status: 404 },
      );

    const result: any = {
      success: true,
      stored: {
        before: order.healthBefore || null,
        after: order.healthAfter || null,
      },
      live: null,
    };

    // A live reading needs the account credentials; without them we still
    // return whatever the bootstrap captured.
    if (
      !order.cpanelHost ||
      !order.cpanelUser ||
      !order.cpanelApiTokenEncrypted
    ) {
      return NextResponse.json({
        ...result,
        live: {
          ok: false,
          unavailable: "This order is not linked to a cPanel account yet.",
        },
      });
    }

    const creds = {
      host: order.cpanelHost,
      user: order.cpanelUser,
      apiToken: decryptCpanelToken(order.cpanelApiTokenEncrypted),
    };

    const [prefix, snapshot] = await Promise.all([
      cpanelAccountPrefix(creds).catch(() => null),
      readCpanelHealth(
        (m, f, p) => cpanelUapiCall(creds, m, f, p),
        order.cpanelHost,
        order.cpanelUser,
      ).catch(() => null),
    ]);

    return NextResponse.json({
      ...result,
      live: snapshot,
      account: prefix
        ? {
            dbPrefix: prefix.dbPrefix,
            accountName: prefix.accountName,
            source: prefix.source,
            message: prefix.message,
          }
        : null,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err?.message || "Could not read cPanel statistics.",
      },
      { status: 500 },
    );
  }
}
