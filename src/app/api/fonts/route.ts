import { FONT_OPTIONS } from "@/lib/fonts";

export async function GET() {
  return Response.json({ fonts: FONT_OPTIONS });
}
