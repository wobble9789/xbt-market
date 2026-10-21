// Extra search words per category, in four parts (generated per group of
// main categories). Loaded with the category search, on demand.
import part1 from './part1.js';
import part2 from './part2.js';
import part3 from './part3.js';
import part4 from './part4.js';

export const SYNONYMS = { ...part1, ...part2, ...part3, ...part4 };
