export function md(parts: TemplateStringsArray, ...values: string[]): string {
  return String.raw(parts, ...values).replaceAll("\\`", "`").trim();
}

export interface PythonExample {
  name: string;
  code: string;
  stdout: string;
  error?: string;
}

export function renderPython(example: PythonExample): string {
  const output = example.stdout.trimEnd() || "(no output)";
  return `\`\`\`python\n${example.code.trim()}\n\`\`\`\n\n**Printed output**\n\n\`\`\`text\n${output}\n\`\`\`${example.error ? `\n\nExecution then raises **${example.error}**. The output above happens before the error.` : ""}`;
}

export function pythonWorkbook() {
  const examples: PythonExample[] = [];
  function py(name: string, code: string, stdout: string, error?: string): string {
    const example = { name, code: code.trim(), stdout, ...(error ? { error } : {}) };
    examples.push(example);
    return renderPython(example);
  }
  return { examples, py };
}
