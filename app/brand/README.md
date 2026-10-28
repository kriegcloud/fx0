# Beep brand assets

The generated `brand.css` and `react.css` are copied unchanged from
`beep-effect/packages/foundation/ui-system/brand/styles`. The app maps its semantic
tokens onto these colors in `app/globals.css`. Update the canonical package before
refreshing these copies; do not modify the generated palette here.

`components/beep-wordmark.tsx` uses the canonical React mark geometry and theme
behavior without introducing dependencies on the Beep monorepo. Icons and static
wordmarks come from that package's `assets/` directory. Its MIT license is included
in `public/brand/LICENSE`.

Inter and JetBrains Mono are self-hosted variable Latin WOFF2 fonts copied from
the Beep checkout's Fontsource packages. Their OFL licenses are included in
`public/brand/`. Next.js fingerprints and serves them locally through `next/font/local`.
