import { NextRequest, NextResponse } from "next/server";
import { deleteDatabase } from "@/lib/storage";

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const success = await deleteDatabase(params.id);
    if (!success) {
      return NextResponse.json({ success: false, error: "Database not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, message: `Database ${params.id} removed successfully.` });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
