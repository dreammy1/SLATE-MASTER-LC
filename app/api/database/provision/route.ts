import { NextRequest, NextResponse } from "next/server";
import { DatabaseProvisioningService } from "@/lib/dbCreator";

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    const { mode, ...config } = payload;

    if (mode === "cpanel") {
      const res = await DatabaseProvisioningService.provisionCpanel(config);
      return NextResponse.json(res);
    } else {
      const res = await DatabaseProvisioningService.provisionDirectMySQL(config);
      return NextResponse.json(res);
    }
  } catch (err: any) {
    return NextResponse.json({ success: false, message: err.message }, { status: 500 });
  }
}
