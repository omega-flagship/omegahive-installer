# Body Container

body_container is the grounded symbolic handle for the VM body that the agent
is running inside. It is not a second agent and it does not call an LLM. A
platform launcher starts the VM, writes a tiny host descriptor, and then the
agent observes that descriptor from inside the VM.

The intent is recursive embodiment without doubled cognition cost:

- host runner starts the body
- VM hosts the runtime
- MeTTa atoms represent that body
- skills observe the body and its launcher grounding

Skills:

- body-container-status
- body-container-self
- body-container-launcher
- body-container-last-trace
