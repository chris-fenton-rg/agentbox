import { NextResponse } from 'next/server';
import { getLatestVersion } from '@/lib/version';

// JSON version endpoint used by the static marketing home to fill its version
// badge client-side. Hourly ISR, same source/fallback as the docs badge.
export const revalidate = 3600;

export async function GET() {
  const version = await getLatestVersion();
  return NextResponse.json({ version });
}
