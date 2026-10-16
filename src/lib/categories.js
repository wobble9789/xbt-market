// Listing categories: the main categories of Marktplaats, with the same URL
// slugs as ids, so a Marktplaats import keeps its category (its ad URLs start
// with /v/<category>/…). Pure data, shared by the app, the importer and tests.

export const CATEGORY_LIST = [
  ['antiek-en-kunst', 'Antiek en Kunst', 'Antiques and Art'],
  ['audio-tv-en-foto', 'Audio, Tv en Foto', 'Audio, TV and Photo'],
  ['auto-s', "Auto's", 'Cars'],
  ['auto-onderdelen', 'Auto-onderdelen', 'Car parts'],
  ['auto-diversen', 'Auto diversen', 'Car accessories'],
  ['boeken', 'Boeken', 'Books'],
  ['caravans-en-kamperen', 'Caravans en Kamperen', 'Caravans and Camping'],
  ['cd-s-en-dvd-s', "Cd's en Dvd's", 'CDs and DVDs'],
  ['computers-en-software', 'Computers en Software', 'Computers and Software'],
  ['contacten-en-berichten', 'Contacten en Berichten', 'Contacts and Messages'],
  ['diensten-en-vakmensen', 'Diensten en Vakmensen', 'Services and Trades'],
  ['dieren-en-toebehoren', 'Dieren en Toebehoren', 'Animals and Supplies'],
  ['doe-het-zelf-en-verbouw', 'Doe-het-zelf en Verbouw', 'DIY and Renovation'],
  ['fietsen-en-brommers', 'Fietsen en Brommers', 'Bikes and Mopeds'],
  ['hobby-en-vrije-tijd', 'Hobby en Vrije tijd', 'Hobby and Leisure'],
  ['huis-en-inrichting', 'Huis en Inrichting', 'Home and Interior'],
  ['huizen-en-kamers', 'Huizen en Kamers', 'Houses and Rooms'],
  ['kinderen-en-baby-s', "Kinderen en Baby's", 'Kids and Babies'],
  ['kleding-dames', 'Kleding | Dames', 'Clothing | Women'],
  ['kleding-heren', 'Kleding | Heren', 'Clothing | Men'],
  ['motoren', 'Motoren', 'Motorbikes'],
  ['muziek-en-instrumenten', 'Muziek en Instrumenten', 'Music and Instruments'],
  ['postzegels-en-munten', 'Postzegels en Munten', 'Stamps and Coins'],
  ['sieraden-tassen-en-uiterlijk', 'Sieraden, Tassen en Uiterlijk', 'Jewellery, Bags and Beauty'],
  ['spelcomputers-en-games', 'Spelcomputers en Games', 'Consoles and Games'],
  ['sport-en-fitness', 'Sport en Fitness', 'Sports and Fitness'],
  ['telecommunicatie', 'Telecommunicatie', 'Phones and Telecom'],
  ['tickets-en-kaartjes', 'Tickets en Kaartjes', 'Tickets'],
  ['tuin-en-terras', 'Tuin en Terras', 'Garden and Patio'],
  ['vacatures', 'Vacatures', 'Jobs'],
  ['vakantie', 'Vakantie', 'Holidays'],
  ['verzamelen', 'Verzamelen', 'Collectibles'],
  ['watersport-en-boten', 'Watersport en Boten', 'Water sports and Boats'],
  ['witgoed-en-apparatuur', 'Witgoed en Apparatuur', 'Appliances'],
  ['zakelijke-goederen', 'Zakelijke goederen', 'Business goods'],
  ['diversen', 'Diversen', 'Miscellaneous'],
];

export const CATEGORIES = CATEGORY_LIST.map(([id]) => id);
export const DEFAULT_CATEGORY = 'diversen';

// Offered, not shipped: no condition, no delivery options, a price per hour or
// day, and a trade that is "done" instead of "shipped".
export const SERVICE_CATEGORIES = new Set(['diensten-en-vakmensen', 'vacatures', 'contacten-en-berichten', 'huizen-en-kamers', 'vakantie']);
export const isService = (category) => SERVICE_CATEGORIES.has(category);

// Price units (NIP-99 price frequency).
export const PRICE_UNITS = ['', 'hour', 'day', 'week', 'month'];

// Categories used before the switch to Marktplaats categories.
const LEGACY = {
  electronics: 'audio-tv-en-foto', computers: 'computers-en-software', phones: 'telecommunicatie',
  'bitcoin-hardware': 'computers-en-software', books: 'boeken', music: 'muziek-en-instrumenten',
  games: 'spelcomputers-en-games', toys: 'kinderen-en-baby-s', kids: 'kinderen-en-baby-s',
  home: 'huis-en-inrichting', garden: 'tuin-en-terras', sports: 'sport-en-fitness',
  bikes: 'fietsen-en-brommers', collectibles: 'verzamelen', art: 'antiek-en-kunst',
  beauty: 'sieraden-tassen-en-uiterlijk', bags: 'sieraden-tassen-en-uiterlijk', tools: 'doe-het-zelf-en-verbouw',
  auto: 'auto-diversen', other: 'diversen',
};

export function normalizeCategory(id) {
  const k = String(id || '').toLowerCase();
  if (CATEGORIES.includes(k)) return k;
  return LEGACY[k] || DEFAULT_CATEGORY;
}
