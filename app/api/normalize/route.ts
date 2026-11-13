import { NextResponse } from "next/server";
import { normalise, type InFile } from "@/lib/normalize";

export const maxDuration = 300;

// Files are read in memory, sent to Claude, and returned. Nothing is stored.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { files: InFile[]; agency: string };
    if (!body.files?.length) return NextResponse.json({ error: "No files were uploaded." }, { status: 400 });
    const data = await normalise(body.files, body.agency);
    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Something went wrong reading the files.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
