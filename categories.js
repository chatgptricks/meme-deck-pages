// Browsing categories are independent of each recording's original source pack.
export const BANKS = [
  { id: 'fav', name: 'Favoritos' },
  { id: 'custom', name: 'Mis sonidos' },
  { id: 'reactions', name: 'Reacciones y voces', label: 'Reacciones' },
  { id: 'quotes', name: 'Frases y memes', label: 'Frases' },
  { id: 'effects', name: 'Efectos y remates', label: 'Efectos' },
  { id: 'games', name: 'Videojuegos', label: 'Juegos' },
  { id: 'cartoons', name: 'Cartoons clásicos', label: 'Cartoons' },
  { id: 'animals', name: 'Animales' },
  { id: 'mj', name: 'Michael Jackson' },
  { id: 'betty', name: 'Betty la fea' },
  { id: 'ticos', name: 'Audios ticos' },
  { id: 'disfraces', name: 'Disfraces' }
];

const legacyBanks = new Map([
  ['all', 'reactions'], ['taunts', 'quotes'], ['drama', 'effects'],
  ['stings', 'effects'], ['sfx', 'effects'], ['gaming', 'games']
]);

export function resolveBank(saved) {
  const value = typeof saved === 'string' ? saved : 'reactions';
  const id = legacyBanks.get(value) || value;
  return BANKS.some(bank => bank.id === id) ? id : 'reactions';
}
