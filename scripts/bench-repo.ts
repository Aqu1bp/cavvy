// A 100,000-file repository of small C sources in 400 folders, with a Makefile per folder for the agents' builds: the
// heavy-use workload's large repository (scripts/bench-ramp.ts). Commit it once made: the sessions' worktrees start there.
//
//   bun scripts/bench-repo.ts <empty folder> [files]   then: git -C <folder> init -q && git -C <folder> add -A && git -C <folder> commit -qm init
import { mkdirSync, writeFileSync } from "fs"; import { join } from "path";
const root = process.argv[2]!; const N = Number(process.argv[3] ?? 100000); const per = 250;
for (let d = 0; d < N / per; d++) {
  const dir = join(root, `mod${String(d).padStart(3, "0")}`, `sub${d % 7}`); mkdirSync(dir, { recursive: true });
  for (let f = 0; f < per; f++) {
    const body = Array.from({ length: 20 + ((d * 31 + f) % 40) }, (_, i) => `int f${d}_${f}_${i}(int x) { return x * ${i + 1} + ${f}; }`).join("\n");
    writeFileSync(join(dir, `file${f}.c`), `/* module ${d}, file ${f} */\n#include <stddef.h>\n${body}\n`);
  }
  writeFileSync(join(dir, "Makefile"), `OBJ=$(patsubst %.c,%.o,$(wildcard file1*.c))\nall: $(OBJ)\n%.o: %.c\n\t$(CC) -O1 -c $< -o /dev/null\n.PHONY: all\n`);
}
writeFileSync(join(root, ".gitignore"), "*.o\n");
