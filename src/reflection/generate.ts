import {fs, path, exists, readFileUtf8} from "../adapter.node";

import {DirBuilder, dts, r, t} from "./builders";
import {createClient, Client} from "../index.node";

import {ConnectConfig} from "../conUtils";

import {getCasts, Casts} from "./queries/getCasts";
import {getScalars, ScalarTypes} from "./queries/getScalars";
import {FunctionTypes, getFunctions} from "./queries/getFunctions";
import {getOperators, OperatorTypes} from "./queries/getOperators";
import * as introspect from "./queries/getTypes";
import * as genutil from "./util/genutil";

import {generateCastMaps} from "./generators/generateCastMaps";
import {generateScalars} from "./generators/generateScalars";
import {generateObjectTypes} from "./generators/generateObjectTypes";
import {generateRuntimeSpec} from "./generators/generateRuntimeSpec";
import {generateFunctionTypes} from "./generators/generateFunctionTypes";
import {generateOperators} from "./generators/generateOperatorTypes";
import {generateSetImpl} from "./generators/generateSetImpl";

const DEBUG = false;

export const configFileHeader = `// EdgeDB query builder. To update, run \`npx edgeql-js\``;

export type GeneratorParams = {
  dir: DirBuilder;
  types: introspect.Types;
  typesByName: Record<string, introspect.Type>;
  casts: Casts;
  scalars: ScalarTypes;
  functions: FunctionTypes;
  operators: OperatorTypes;
};

export function exitWithError(message: string): never {
  // tslint:disable-next-line
  console.error(message);
  process.exit(1);
}

export async function generateQB(params: {
  outputDir: string;
  connectionConfig: ConnectConfig;
  target: "ts" | "esm" | "cjs";
}): Promise<void> {
  const {outputDir, connectionConfig, target} = params;
  // tslint:disable-next-line
  console.log(`Connecting to EdgeDB instance...`);
  let cxn: Client;
  try {
    cxn = createClient({
      ...connectionConfig,
      concurrency: 5,
    });
  } catch (e) {
    return exitWithError(`Failed to connect: ${(e as Error).message}`);
  }

  const dir = new DirBuilder();

  try {
    // tslint:disable-next-line
    console.log(`Introspecting database schema...`);

    const [types, scalars, casts, functions, operators] = await Promise.all([
      introspect.getTypes(cxn, {debug: DEBUG}),
      getScalars(cxn),
      getCasts(cxn, {debug: DEBUG}),
      getFunctions(cxn),
      getOperators(cxn),
    ]);

    const typesByName: Record<string, introspect.Type> = {};
    for (const type of types.values()) {
      typesByName[type.name] = type;

      // skip "anytype" and "anytuple"
      if (!type.name.includes("::")) continue;
    }

    const generatorParams: GeneratorParams = {
      dir,
      types,
      typesByName,
      casts,
      scalars,
      functions,
      operators,
    };
    generateRuntimeSpec(generatorParams);
    generateCastMaps(generatorParams);
    generateScalars(generatorParams);
    generateObjectTypes(generatorParams);
    generateFunctionTypes(generatorParams);
    generateOperators(generatorParams);
    generateSetImpl(generatorParams);

    // generate module imports

    const importsFile = dir.getPath("imports");

    importsFile.addExportStarFrom("edgedb", "edgedb");
    importsFile.addExportFrom({spec: true}, "./__spec__", true);
    importsFile.addExportStarFrom("syntax", "./syntax/syntax", true);
    importsFile.addExportStarFrom("castMaps", "./castMaps", true);

    /////////////////////////
    // generate index file
    /////////////////////////

    const index = dir.getPath("index");
    index.addExportStarFrom(null, "./castMaps", true);
    index.addExportStarFrom(null, "./syntax/syntax", true);
    index.addImport({$: true}, "edgedb");
    index.addExportFrom({createClient: true}, "edgedb", true);
    index.addStarImport("$syntax", "./syntax/syntax", true);
    index.addStarImport("$op", "./operators", true);

    const spreadModules = [
      {
        name: "$op",
        keys: ["op"],
      },
      {
        name: "$syntax",
        keys: [
          "ASC",
          "DESC",
          "EMPTY_FIRST",
          "EMPTY_LAST",
          "alias",
          "array",
          "cast",
          "detached",
          "for",
          "insert",
          "is",
          "literal",
          "namedTuple",
          "optional",
          "select",
          "set",
          "tuple",
          "with",
          "withParams",
        ],
      },
      {
        name: "_default",
        module: dir.getModule("default"),
      },
      {name: "_std", module: dir.getModule("std")},
    ];
    const excludedKeys = new Set<string>(dir._modules.keys());

    const spreadTypes: string[] = [];
    for (let {name, keys, module} of spreadModules) {
      if (module?.isEmpty()) {
        continue;
      }
      keys = keys ?? module!.getDefaultExportKeys();
      const conflictingKeys = keys.filter(key => excludedKeys.has(key));
      let typeStr: string;
      if (conflictingKeys.length) {
        typeStr = `Omit<typeof ${name}, ${conflictingKeys
          .map(genutil.quote)
          .join(" | ")}>`;
      } else {
        typeStr = `typeof ${name}`;
      }
      spreadTypes.push(
        name === "$syntax" ? `$.util.OmitDollarPrefixed<${typeStr}>` : typeStr
      );
      for (const key of keys) {
        excludedKeys.add(key);
      }
    }

    index.nl();
    index.writeln([
      dts`declare `,
      `const ExportDefault`,
      t`: ${spreadTypes.reverse().join(" & \n  ")} & {`,
    ]);
    index.indented(() => {
      for (const [moduleName, internalName] of dir._modules) {
        if (dir.getModule(moduleName).isEmpty()) continue;
        index.writeln([
          t`${genutil.quote(moduleName)}: typeof _${internalName};`,
        ]);
      }
    });

    index.writeln([t`}`, r` = {`]);
    index.indented(() => {
      for (const {name, module} of [...spreadModules].reverse()) {
        if (module?.isEmpty()) {
          continue;
        }
        index.writeln([
          r`...${
            name === "$syntax" ? `$.util.omitDollarPrefixed($syntax)` : name
          },`,
        ]);
      }

      for (const [moduleName, internalName] of dir._modules) {
        if (dir.getModule(moduleName).isEmpty()) {
          continue;
        }
        index.addDefaultImport(
          `_${internalName}`,
          `./modules/${internalName}`,
          true
        );

        index.writeln([r`${genutil.quote(moduleName)}: _${internalName},`]);
      }
    });
    index.writeln([r`};`]);
    index.addExport("ExportDefault", undefined, true);

    // re-export some reflection types
    index.addExportFrom({Cardinality: true}, "edgedb/dist/reflection");
    index.writeln([
      t`export `,
      dts`declare `,
      t`type Set<
  Type extends $.BaseType,
  Cardinality extends $.Cardinality = $.Cardinality.Many
> = $.TypeSet<Type, Cardinality>;`,
    ]);
  } finally {
    await cxn.close();
  }

  await dir.write(
    outputDir,
    target === "ts" ? "ts" : "js+dts",
    target === "cjs" ? "cjs" : "esm"
  );

  // write syntax files
  const syntaxDir = path.join(__dirname, "..", "syntax");
  const syntaxOutDir = path.join(outputDir, "syntax");
  if (!(await exists(syntaxOutDir))) {
    await fs.mkdir(syntaxOutDir);
  }

  const syntaxFiles = await fs.readdir(syntaxDir);
  for (const fileName of syntaxFiles) {
    const filetype = fileName.endsWith(".js")
      ? "js"
      : fileName.endsWith(".mjs")
      ? "esm"
      : fileName.endsWith(".ts")
      ? fileName.endsWith(".d.ts")
        ? "dts"
        : "ts"
      : null;
    if (
      (target === "ts" && filetype !== "ts") ||
      (target === "esm" && !(filetype === "esm" || filetype === "dts")) ||
      (target === "cjs" && !(filetype === "js" || filetype === "dts"))
    ) {
      continue;
    }
    const filePath = path.join(syntaxDir, fileName);
    let contents = await readFileUtf8(filePath);

    // rewrite scoped import paths
    if (filetype === "js") {
      contents = contents
        .replace(
          /require\("(..\/)?reflection(.*)"\)/g,
          `require("edgedb/dist/reflection$2")`
        )
        .replace(/require\("@generated\//g, `require("../`);
    } else {
      contents = contents
        .replace(
          /from "(..\/)?reflection(.*)"/g,
          `from "edgedb/dist/reflection$2${filetype === "esm" ? ".js" : ""}"`
        )
        .replace(/from "@generated\//g, `from "../`);

      if (filetype === "esm") {
        contents = contents
          .replace(
            /from "edgedb\/dist\/reflection\.js"/g,
            `from "edgedb/dist/reflection/index.js"`
          )
          .replace(/from "(\.?\.\/.+)"/g, `from "$1.mjs"`);
      }
    }

    const outputPath = path.join(syntaxOutDir, fileName);
    await fs.writeFile(outputPath, contents);
  }

  await fs.writeFile(
    path.join(outputDir, "config.json"),
    `${configFileHeader}\n${JSON.stringify({target})}\n`
  );
}
