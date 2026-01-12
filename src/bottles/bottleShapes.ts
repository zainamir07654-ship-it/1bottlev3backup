export type BottleShape = { id: string; label: string; outlinePath: string; cavityPath: string };

export const BOTTLE_SHAPES: BottleShape[] = [
  {
    id: "sports",
    label: "Sports",
    outlinePath: new URL("./shapes/sports/bottle-outline.svg", import.meta.url).href,
    cavityPath: new URL("./shapes/sports/bottle-cavity.svg", import.meta.url).href,
  },
];
