// Paseo supplies this module at runtime. The entry only needs the platform name.
declare module "react-native" {
  export const Platform: { readonly OS: string };
}
