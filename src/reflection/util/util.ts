export {cardinalityUtil} from "./cardinalityUtil";
export type {typeutil} from "./typeutil";
export * as genutil from "./genutil";

export namespace util {
  export function assertNever(arg: never, error?: Error): never {
    throw error ?? new Error(`${arg} is supposed to be of "never" type`);
  }

  export const deduplicate = (args: string[]) => [...new Set(args)];

  export const getFromArrayMap = <T>(map: Record<string, T[]>, id: string) => {
    return map[id] || [];
  };
  type PropertyDef = {
    configurable?: boolean;
    enumerable?: boolean;
    writable?: boolean;
    value?: any;
    set?: (v: any) => any;
    get?: () => any;
  };

  export const defineProperty = <T>(
    obj: T,
    name: string,
    def: PropertyDef & ThisType<T>
  ): T => {
    return Object.defineProperty(obj, name, def) as any;
  };

  export const defineGetter = <T>(
    obj: T,
    name: string,
    getter: (this: T) => any
  ): T => {
    return Object.defineProperty(obj, name, {
      get: getter,
      enumerable: true,
    }) as any;
  };

  export const defineMethod = <
    T
    // Def extends PropertyDef<T, P>
  >(
    obj: T,
    name: string,
    method: (this: T) => any
  ): T => {
    (obj as any)[name] = method.bind(obj);
    return obj;
  };
}