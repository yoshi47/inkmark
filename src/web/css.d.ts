// TS 6.0 rejects side-effect imports it cannot resolve (TS2882); .css is Vite's to bundle, not tsc's.
declare module '*.css';
