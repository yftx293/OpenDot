// Product-owned vector silhouettes shared by the picker and every Bot surface.
export const BOT_AVATAR_SHAPES = [
  {
    id: 'blob',
    label: '团块',
    path: 'M31 5C46 3 59 17 59 32C59 48 46 60 30 59C14 59 4 46 5 30C6 15 16 5 31 5Z',
  },
  {
    id: 'cloud',
    label: '云朵',
    path: 'M16 18C12 4 33 0 39 13C55 5 66 27 54 36C63 52 43 64 32 53C18 65 1 49 10 37C-1 27 4 17 16 18Z',
  },
  {
    id: 'square',
    label: '方形',
    path: 'M13 8H51Q57 8 57 14V50Q57 56 51 56H13Q7 56 7 50V14Q7 8 13 8Z',
  },
  {
    id: 'spark',
    label: '星芒',
    path: 'M32 3Q38 3 41 20Q61 23 61 32Q61 39 42 43Q38 61 32 61Q25 61 21 43Q3 39 3 32Q3 25 21 21Q25 3 32 3Z',
  },
  {
    id: 'clover',
    label: '四叶草',
    path: 'M32 12C12-8-8 14 12 32C-8 50 14 72 32 52C50 72 72 50 52 32C72 14 50-8 32 12Z',
  },
  {
    id: 'heart',
    label: '爱心',
    path: 'M32 58C27 56 4 39 4 22C4 2 26 0 32 16C38 0 60 2 60 22C60 39 37 56 32 58Z',
  },
  {
    id: 'flower',
    label: '花朵',
    path: 'M32 4C42 4 43 13 43 13C56 8 62 20 53 29C67 39 56 54 45 49C42 64 25 64 22 50C8 55-1 40 11 30C1 19 12 8 22 14C22 14 22 4 32 4Z',
  },
  {
    id: 'drop',
    label: '水滴',
    path: 'M32 3C39 12 57 28 57 39C57 68 7 68 7 39C7 28 25 12 32 3Z',
  },
  {
    id: 'pill',
    label: '药片',
    path: 'M22 11H42C69 11 69 53 42 53H22C-5 53-5 11 22 11Z',
  },
  {
    id: 'wedge',
    label: '楔形',
    path: 'M17 5Q22 1 29 9L57 38Q66 49 50 54L17 60Q3 62 5 47L10 16Q11 8 17 5Z',
  },
  {
    id: 'house',
    label: '房子',
    path: 'M8 26L27 7Q32 3 37 7L56 26V51Q56 58 49 58H15Q8 58 8 51Z',
  },
  {
    id: 'star',
    label: '星形',
    path: 'M32 3L41 21L61 24L46 39L50 60L32 50L14 60L18 39L3 24L23 21Z',
  },
  { id: 'hexagon', label: '六边形', path: 'M17 5H47L61 32L47 59H17L3 32Z' },
] as const;
export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number]['id'];
export const BOT_AVATAR_SHAPE_IDS = BOT_AVATAR_SHAPES.map(
  (shape) => shape.id,
) as [BotAvatarShape, ...BotAvatarShape[]];
