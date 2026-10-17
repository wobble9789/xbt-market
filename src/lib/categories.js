// Listing categories: the main categories of Marktplaats ([id, nl, en, es]; the
// subcategories are in category-tree.js, loaded on demand), with the same URL
// slugs as ids, so a Marktplaats import keeps its category (its ad URLs start
// with /v/<category>/…). Pure data, shared by the app, the importer and tests.

export const CATEGORY_LIST = [
  ["antiek-en-kunst","Antiek en Kunst","Antiques and Art","Antigüedades y Arte"],
  ["audio-tv-en-foto","Audio, Tv en Foto","Audio, TV and Photo","Audio, TV y Foto"],
  ["auto-s","Auto's","Cars","Coches"],
  ["auto-onderdelen","Auto-onderdelen","Car Parts","Recambios de coche"],
  ["auto-diversen","Auto diversen","Car Miscellaneous","Varios de coche"],
  ["boeken","Boeken","Books","Libros"],
  ["caravans-en-kamperen","Caravans en Kamperen","Caravans and Camping","Caravanas y Camping"],
  ["cd-s-en-dvd-s","Cd's en Dvd's","CDs and DVDs","CDs y DVDs"],
  ["computers-en-software","Computers en Software","Computers and Software","Ordenadores y Software"],
  ["contacten-en-berichten","Contacten en Berichten","Contacts and Messages","Contactos y Mensajes"],
  ["diensten-en-vakmensen","Diensten en Vakmensen","Services and Professionals","Servicios y Profesionales"],
  ["dieren-en-toebehoren","Dieren en Toebehoren","Animals and Supplies","Animales y Accesorios"],
  ["doe-het-zelf-en-verbouw","Doe-het-zelf en Verbouw","DIY and Renovation","Bricolaje y Reformas"],
  ["fietsen-en-brommers","Fietsen en Brommers","Bicycles and Mopeds","Bicicletas y Ciclomotores"],
  ["hobby-en-vrije-tijd","Hobby en Vrije tijd","Hobbies and Leisure","Aficiones y Ocio"],
  ["huis-en-inrichting","Huis en Inrichting","Home and Interior","Casa y Decoración"],
  ["huizen-en-kamers","Huizen en Kamers","Houses and Rooms","Casas y Habitaciones"],
  ["kinderen-en-baby-s","Kinderen en Baby's","Children and Babies","Niños y Bebés"],
  ["kleding-dames","Kleding | Dames","Women's Clothing","Ropa de mujer"],
  ["kleding-heren","Kleding | Heren","Men's Clothing","Ropa de hombre"],
  ["motoren","Motoren","Motorcycles","Motos"],
  ["muziek-en-instrumenten","Muziek en Instrumenten","Music and Instruments","Música e Instrumentos"],
  ["postzegels-en-munten","Postzegels en Munten","Stamps and Coins","Sellos y Monedas"],
  ["sieraden-tassen-en-uiterlijk","Sieraden, Tassen en Uiterlijk","Jewellery, Bags and Beauty","Joyas, Bolsos y Belleza"],
  ["spelcomputers-en-games","Spelcomputers en Games","Game Consoles and Games","Consolas y Videojuegos"],
  ["sport-en-fitness","Sport en Fitness","Sports and Fitness","Deporte y Fitness"],
  ["telecommunicatie","Telecommunicatie","Telecommunications","Telecomunicaciones"],
  ["tickets-en-kaartjes","Tickets en Kaartjes","Tickets","Entradas y Billetes"],
  ["tuin-en-terras","Tuin en Terras","Garden and Patio","Jardín y Terraza"],
  ["vacatures","Vacatures","Jobs","Empleo"],
  ["vakantie","Vakantie","Holidays","Vacaciones"],
  ["verzamelen","Verzamelen","Collectibles","Coleccionismo"],
  ["watersport-en-boten","Watersport en Boten","Water Sports and Boats","Deportes acuáticos y Barcos"],
  ["witgoed-en-apparatuur","Witgoed en Apparatuur","Appliances and Equipment","Electrodomésticos y Aparatos"],
  ["zakelijke-goederen","Zakelijke goederen","Business Goods","Bienes para empresas"],
  ["diversen","Diversen","Miscellaneous","Varios"],
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

// Subcategories (Marktplaats level 2), loaded on demand: the full tree is large.
let treePromise = null;
export function loadCategoryTree() {
  treePromise ||= import('./category-tree.js').then(({ CATEGORY_TREE }) => new Map(CATEGORY_TREE.map(([id, , , , children = []]) => [id, children])));
  return treePromise;
}

export const isSubcategorySlug = (s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s || '');
