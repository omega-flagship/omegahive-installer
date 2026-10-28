# Publishing Module

This module exposes OmegaClaw's publishing affordance as a portable skill pack.
The module is the symbolic surface; the current implementation delegates to an
optional local `webhost` backend when one is mounted in the runtime.

The module can be imported explicitly:

```metta
!(import! &self (library OmegaClaw-Core ./modules/publishing/entry.metta))
```

It provides skills such as:

- `publish-artifact`
- `list-published-artifacts`
- `unpublish-artifact`
- `write-web-page`
- `public-web-url`
- `webhost-status`

If no publishing backend is configured, calls fail closed with
`PUBLISHING-NOT-CONFIGURED`.
