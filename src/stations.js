// Common U.S. duty stations and the nearby city that Qloo resolves as a locality.
// The city is what the agent sends to Qloo; the installation name is only a label.
export const STATIONS = [
  { id: "fort-bragg", label: "Fort Bragg, NC", locality: "Fayetteville, North Carolina" },
  { id: "fort-campbell", label: "Fort Campbell, KY", locality: "Clarksville, Tennessee" },
  { id: "fort-hood", label: "Fort Hood, TX", locality: "Killeen, Texas" },
  { id: "fort-bliss", label: "Fort Bliss, TX", locality: "El Paso, Texas" },
  { id: "fort-carson", label: "Fort Carson, CO", locality: "Colorado Springs, Colorado" },
  { id: "jblm", label: "Joint Base Lewis-McChord, WA", locality: "Tacoma, Washington" },
  { id: "fort-stewart", label: "Fort Stewart, GA", locality: "Hinesville, Georgia" },
  { id: "fort-benning", label: "Fort Benning, GA", locality: "Columbus, Georgia" },
  { id: "fort-riley", label: "Fort Riley, KS", locality: "Junction City, Kansas" },
  { id: "fort-drum", label: "Fort Drum, NY", locality: "Watertown, New York" },
  { id: "fort-sill", label: "Fort Sill, OK", locality: "Lawton, Oklahoma" },
  { id: "fort-leonard-wood", label: "Fort Leonard Wood, MO", locality: "Waynesville, Missouri" },
  { id: "fort-wainwright", label: "Fort Wainwright, AK", locality: "Fairbanks, Alaska" },
  { id: "schofield", label: "Schofield Barracks, HI", locality: "Wahiawa, Hawaii" },
  { id: "jbphh", label: "Joint Base Pearl Harbor-Hickam, HI", locality: "Honolulu, Hawaii" },
  { id: "mcbh", label: "Marine Corps Base Hawaii, HI", locality: "Kaneohe, Hawaii" },
  { id: "camp-lejeune", label: "Camp Lejeune, NC", locality: "Jacksonville, North Carolina" },
  { id: "camp-pendleton", label: "Camp Pendleton, CA", locality: "Oceanside, California" },
  { id: "nb-san-diego", label: "Naval Base San Diego, CA", locality: "San Diego, California" },
  { id: "ns-norfolk", label: "Naval Station Norfolk, VA", locality: "Norfolk, Virginia" },
  { id: "nb-kitsap", label: "Naval Base Kitsap, WA", locality: "Bremerton, Washington" },
  { id: "nas-jax", label: "NAS Jacksonville, FL", locality: "Jacksonville, Florida" },
  { id: "jbsa", label: "Joint Base San Antonio, TX", locality: "San Antonio, Texas" },
  { id: "jb-langley-eustis", label: "Joint Base Langley-Eustis, VA", locality: "Hampton, Virginia" },
  { id: "eglin", label: "Eglin AFB, FL", locality: "Fort Walton Beach, Florida" },
  { id: "nellis", label: "Nellis AFB, NV", locality: "Las Vegas, Nevada" },
  { id: "wright-patt", label: "Wright-Patterson AFB, OH", locality: "Dayton, Ohio" },
  { id: "pentagon", label: "The Pentagon, VA", locality: "Arlington, Virginia" },
];

export function stationById(id) {
  return STATIONS.find((s) => s.id === id) || null;
}

// Resolve the destination the user picked: a preset id or a free-text city.
export function resolveDestination({ stationId, otherCity }) {
  const preset = stationId ? stationById(stationId) : null;
  if (preset) return { label: preset.label, locality: preset.locality };
  const city = (otherCity || "").trim();
  if (city) return { label: city, locality: city };
  return null;
}
