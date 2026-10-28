# Game Boy Simulation Module

This module exposes a Game Boy emulator as a symbolic simulation organ for the
runtime. It is intended for experiments where an agent learns to observe a
game, choose actions, verify outcomes, and remember strategy.

The module does not include commercial ROMs. ROMs belong in ignored runtime
storage:

```text
memory/runtime/gameboy/roms/pokemon-yellow.gb
```

For smoke testing, `gb-load demo` uses PyBoy's bundled default ROM.

Provided skills:

- `gb-status`
- `gb-load game`
- `gb-observe`
- `gb-step buttons frames`
- `gb-screenshot`
- `gb-save-state name`
- `gb-load-state name`
- `gb-stop`
- `gb-last-trace`

The emulator runs headless with PyBoy. Each action/observation writes a small
JSON trace into ignored runtime memory.
