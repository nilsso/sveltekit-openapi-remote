import * as fs from "node:fs";
import * as path from "node:path";

export interface PathInfo {
  path: string;
  methods: {
    method: "get" | "post" | "patch" | "put" | "delete";
    hasParams: boolean;
    hasBody: boolean;
    hasQuery: boolean;
  }[];
}

export type Validator = "zod" | "valibot";

export interface GeneratorOptions {
  output: string;
  typesImport: string;
  clientImport: string;
  validator: Validator;
  grouping: "single" | "segment";
  depth: number;
}

function extractInterfaceBody(content: string, name: string): string | null {
  const startRegex = new RegExp(`export interface ${name}\\s*\\{`);
  const startMatch = startRegex.exec(content);
  if (!startMatch) return null;

  let depth = 1;
  let pos = startMatch.index + startMatch[0].length;

  while (pos < content.length && depth > 0) {
    if (content[pos] === "{") depth++;
    else if (content[pos] === "}") depth--;
    pos++;
  }

  return content.slice(startMatch.index + startMatch[0].length, pos - 1);
}

function extractPathBlock(content: string, startIndex: number): string | null {
  // Find the colon after the key, then the opening brace after it
  const colonPos = content.indexOf(":", startIndex);
  if (colonPos === -1) return null;
  let pos = content.indexOf("{", colonPos);
  if (pos === -1) return null;

  let depth = 1;
  pos++;

  while (pos < content.length && depth > 0) {
    if (content[pos] === "{") depth++;
    else if (content[pos] === "}") depth--;
    pos++;
  }

  return content.slice(startIndex, pos);
}

export function extractPaths(apiTypesContent: string): PathInfo[] {
  const pathsContent = extractInterfaceBody(apiTypesContent, "paths");
  if (!pathsContent) {
    throw new Error("Could not find paths interface in api.d.ts");
  }

  const pathKeyRegex = /"(\/[^"]*)":\s*\{/g;
  const paths: PathInfo[] = [];

  let match;
  while ((match = pathKeyRegex.exec(pathsContent)) !== null) {
    const pathStr = match[1];
    const pathBlock = extractPathBlock(pathsContent, match.index);
    if (!pathBlock) continue;

    // Advance past this block to avoid matching nested keys
    pathKeyRegex.lastIndex = match.index + pathBlock.length;

    const methods: PathInfo["methods"] = [];
    const methodChecks = [
      { method: "get" as const, regex: /\bget:\s*(?:operations\[|\{)/ },
      { method: "post" as const, regex: /\bpost:\s*(?:operations\[|\{)/ },
      { method: "patch" as const, regex: /\bpatch:\s*(?:operations\[|\{)/ },
      { method: "put" as const, regex: /\bput:\s*(?:operations\[|\{)/ },
      { method: "delete" as const, regex: /\bdelete:\s*(?:operations\[|\{)/ },
    ];

    for (const { method, regex } of methodChecks) {
      if (regex.test(pathBlock)) {
        const hasParams = pathStr.includes("{");
        const hasBody = method !== "get" && method !== "delete";
        const hasQuery = method === "get";
        methods.push({ method, hasParams, hasBody, hasQuery });
      }
    }

    if (methods.length > 0) {
      paths.push({ path: pathStr, methods });
    }
  }

  if (paths.length === 0 && pathsContent.trim().length > 0) {
    console.warn(
      "Warning: paths interface found but no HTTP methods detected. " +
        "The api.d.ts format may be unsupported.",
    );
  }

  return paths;
}

export function pathToFunctionName(
  pathStr: string,
  method: string,
  variant?: "Command" | "Form",
): string {
  const segments = pathStr.replace(/^\//, "").split("/");

  const parts = segments.map((segment, index) => {
    // Handle path parameters embedded in segments (e.g. "{id}.ical")
    if (segment.includes("{")) {
      return segment
        .replace(/\{([^}]+)\}/g, (_, param) => {
          return "By" + param.charAt(0).toUpperCase() + param.slice(1);
        })
        .split(/[^a-zA-Z0-9]/)
        .filter(Boolean)
        .map((word, i) => {
          if (index === 0 && i === 0) return word;
          return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join("");
    }

    const words = segment.split(/[^a-zA-Z0-9]/);
    return words
      .filter(Boolean)
      .map((word, i) => {
        if (index === 0 && i === 0) {
          return word;
        }
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join("");
  });

  const baseName = parts.join("");
  const functionName =
    method.toLowerCase() + baseName.charAt(0).toUpperCase() + baseName.slice(1);

  return variant ? functionName + variant : functionName;
}

export function pathToFilename(pathStr: string, depth: number): string {
  const segments = pathStr
    .replace(/^\//, "")
    .split("/")
    .filter((s) => !s.startsWith("{"));

  if (segments.length === 0) {
    return "root.remote.ts";
  }

  const groupSegments = segments.slice(0, depth);
  const fileBase = groupSegments.join("-").replace(/[^a-zA-Z0-9-]/g, "-");

  return `${fileBase}.remote.ts`;
}

/** Generate the content for a single .remote.ts file */
export function generateFileContent(
  paths: PathInfo[],
  typesImport: string,
  clientImport: string,
  validator: Validator,
): string {
  const allHandlers = new Set<string>();
  const allTypes = new Set<string>();

  for (const pathInfo of paths) {
    for (const methodInfo of pathInfo.methods) {
      const m = methodInfo.method;
      if (m === "get") {
        allHandlers.add("handleGetQuery");
        allTypes.add("GetParameters");
        allTypes.add("GetResponse");
      } else if (m === "delete") {
        allHandlers.add("handleDeleteCommand");
        allHandlers.add("handleDeleteForm");
        allTypes.add("GetParameters");
        allTypes.add("GetResponse");
      } else {
        const Method = m.charAt(0).toUpperCase() + m.slice(1);
        allHandlers.add(`handle${Method}Command`);
        allHandlers.add(`handle${Method}Form`);
        if (methodInfo.hasParams) allTypes.add("GetParameters");
        allTypes.add("GetResponse");
        allTypes.add("GetRequestBody");
      }
    }
  }

  const handlerImports = Array.from(allHandlers).sort().join(",\n  ");
  const typeImportList = Array.from(allTypes).sort();
  const typeImportLine =
    typeImportList.length > 0
      ? `import type { ${typeImportList.join(", ")} } from 'sveltekit-openapi-remote';\n`
      : "";
  const validatorImportLine =
    validator === "zod"
      ? "import { z } from 'zod'"
      : "import * as v from 'valibot'";

  const imports = `\
import { query, command, form } from '$app/server';
${validatorImportLine};
import type { paths } from '${typesImport}';
${typeImportLine}import {
  ${handlerImports},
} from '${clientImport}';

/**
 * Auto-generated remote functions
 * DO NOT EDIT - Run 'npx sveltekit-openapi-remote generate' to regenerate
 */
`;

  const functions: string[] = [];
  for (const pathInfo of paths) {
    for (const methodInfo of pathInfo.methods) {
      functions.push(
        ...generateFunctionCode(
          pathInfo.path,
          methodInfo.method,
          methodInfo,
          validator,
        ),
      );
    }
  }

  return imports + "\n" + functions.join("\n\n") + "\n";
}

function generateCustomValidator(type: string, validator: Validator): string {
  // Single type cast
  if (validator === "zod") {
    return `z.custom<${type}>()`;
  } else {
    return `v.custom<${type}>(() => true)`;
  }
}

function generateFormValidator(type: string, validator: Validator): string {
  // Record then cast
  if (validator === "zod") {
    return `z.record(z.string(), z.any()).pipe(z.custom<${type}>())`;
  } else {
    return `v.pipe(v.record(v.string(), v.any()), v.transform(i => i as ${type}))`;
  }
}

function generateObjectValidator(
  pathType: string,
  bodyType: string,
  validator: Validator,
): string {
  // Object with path+body
  if (validator === "zod") {
    return `z.object({
      path: z.custom<${pathType}>(),
      body: z.custom<${bodyType}>()
    })`;
  } else {
    return `v.object({
      path: v.custom<${pathType}>(() => true),
      body: v.custom<${bodyType}>(() => true)
    })`;
  }
}

function generateFormObjectValidator(
  pathType: string,
  bodyType: string,
  validator: Validator,
): string {
  // Form with path+body
  const type = `{ path: ${pathType}; body: ${bodyType}; }`;
  return generateFormValidator(type, validator);
}

function generateFunctionCode(
  pathStr: string,
  method: "get" | "post" | "patch" | "put" | "delete",
  info: PathInfo["methods"][0],
  validator: Validator,
): string[] {
  const codes: string[] = [];
  const paramsType = `GetParameters<paths, '${pathStr}', '${method}'>`;
  const responseType = `GetResponse<paths, '${pathStr}', '${method}'>`;

  if (method === "get") {
    const funcName = pathToFunctionName(pathStr, method);
    codes.push(`\
export const ${funcName} = query(
  ${generateCustomValidator(paramsType, validator)},
  async (params) => handleGetQuery('${pathStr}', params) as Promise<${responseType}>

);`);
  } else if (method === "delete") {
    const commandName = pathToFunctionName(pathStr, method, "Command");
    const formName = pathToFunctionName(pathStr, method, "Form");

    codes.push(`\
export const ${commandName} = command(
  ${generateCustomValidator(paramsType, validator)},
  async (params) => handleDeleteCommand('${pathStr}', params) as Promise<${responseType}>
);`);
    codes.push(`\
export const ${formName} = form(
  ${generateFormValidator(paramsType, validator)},
  async (params) => handleDeleteForm('${pathStr}', params) as Promise<${responseType}>
);`);
  } else if (info.hasParams) {
    const commandName = pathToFunctionName(pathStr, method, "Command");
    const formName = pathToFunctionName(pathStr, method, "Form");
    const methodUpper = method.charAt(0).toUpperCase() + method.slice(1);
    const commandHandler = `handle${methodUpper}Command`;
    const formHandler = `handle${methodUpper}Form`;

    const pathType = `GetParameters<paths, '${pathStr}', '${method}'>['path']`;
    const bodyType = `GetRequestBody<paths, '${pathStr}', '${method}'>`;

    codes.push(`\
export const ${commandName} = command(
  ${generateObjectValidator(pathType, bodyType, validator)},
  async (input) => ${commandHandler}('${pathStr}', input) as Promise<${responseType}>
);`);
    codes.push(`\
export const ${formName} = form(
  ${generateFormObjectValidator(pathType, bodyType, validator)},
  async (input) => ${formHandler}('${pathStr}', input) as Promise<${responseType}>
);`);
  } else {
    const commandName = pathToFunctionName(pathStr, method, "Command");
    const formName = pathToFunctionName(pathStr, method, "Form");
    const methodUpper = method.charAt(0).toUpperCase() + method.slice(1);
    const commandHandler = `handle${methodUpper}Command`;
    const formHandler = `handle${methodUpper}Form`;

    const requestBodyType = `GetRequestBody<paths, '${pathStr}', '${method}'>`;

    codes.push(`\
export const ${commandName} = command(
  ${generateCustomValidator(requestBodyType, validator)},
  async (body) => ${commandHandler}('${pathStr}', body) as Promise<${responseType}>
);`);
    codes.push(`\
export const ${formName} = form(
  ${generateFormValidator(requestBodyType, validator)},
  async (body) => ${formHandler}('${pathStr}', body) as Promise<${responseType}>
);`);
  }

  return codes;
}

export function generateRemoteFiles(
  paths: PathInfo[],
  options: GeneratorOptions,
): Map<string, string> {
  const nameMap = new Map<string, string>();
  for (const pathInfo of paths) {
    for (const methodInfo of pathInfo.methods) {
      const variants =
        methodInfo.method === "get"
          ? [pathToFunctionName(pathInfo.path, methodInfo.method)]
          : [
              pathToFunctionName(pathInfo.path, methodInfo.method, "Command"),
              pathToFunctionName(pathInfo.path, methodInfo.method, "Form"),
            ];
      for (const name of variants) {
        if (nameMap.has(name)) {
          throw new Error(
            `Function name collision: "${name}" is generated by both "${nameMap.get(name)}" and "${pathInfo.path}" (${methodInfo.method})`,
          );
        }
        nameMap.set(name, `${pathInfo.path} (${methodInfo.method})`);
      }
    }
  }

  const fileMap = new Map<string, PathInfo[]>();
  if (options.grouping === "single") {
    fileMap.set("api.remote.ts", paths);
  } else {
    for (const pathInfo of paths) {
      const filename = pathToFilename(pathInfo.path, options.depth);
      if (!fileMap.has(filename)) {
        fileMap.set(filename, []);
      }
      fileMap.get(filename)!.push(pathInfo);
    }
  }

  const result = new Map<string, string>();
  for (const [filename, filePaths] of fileMap.entries()) {
    result.set(
      filename,
      generateFileContent(
        filePaths,
        options.typesImport,
        options.clientImport,
        options.validator,
      ),
    );
  }

  return result;
}

export function writeRemoteFiles(
  files: Map<string, string>,
  outputDir: string,
): void {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  } else {
    const existingFiles = fs.readdirSync(outputDir);
    for (const file of existingFiles) {
      if (file.endsWith(".remote.ts")) {
        const filePath = path.join(outputDir, file);
        const content = fs.readFileSync(filePath, "utf-8");
        if (content.includes("DO NOT EDIT")) {
          fs.unlinkSync(filePath);
        }
      }
    }
  }

  for (const [filename, content] of files.entries()) {
    fs.writeFileSync(path.join(outputDir, filename), content, "utf-8");
  }
}
