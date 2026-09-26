export interface LatLng {
  latitude: number;
  longitude: number;
}

const inNyc = ({ latitude, longitude }: LatLng) =>
  latitude > 40.4 && latitude < 41.0 && longitude > -74.3 && longitude < -73.6;

/**
 * Pull coordinates out of a shared location. iMessage location pins arrive as a small
 * vCard (".loc.vcf") containing an Apple Maps URL like maps.apple.com/?ll=40.807,-73.962;
 * Google Maps links use @40.807,-73.962 or q=40.807,-73.962.
 */
export function parseLatLng(text: string): LatLng | null {
  const patterns = [/[?&](?:ll|q|sll|daddr)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m) continue;
    const loc = { latitude: Number(m[1]), longitude: Number(m[2]) };
    // Only trust coordinates in the NYC area; anything else is probably a parse mistake.
    if (inNyc(loc)) return loc;
  }
  return null;
}
