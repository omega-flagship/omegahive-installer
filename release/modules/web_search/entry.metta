; omegaclaw.external.web-search module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.external.web-search)
(ModuleKind omegaclaw.external.web-search external-info-organ)
(ModuleVersion omegaclaw.external.web-search "0.1.0")
(ModuleEntrypoint omegaclaw.external.web-search "entry.metta")
(ModuleOptional omegaclaw.external.web-search True)
(ModuleDefaultEnabled omegaclaw.external.web-search True)
(ModuleImplementation omegaclaw.external.web-search search-api-membrane)


(Provider web-search)
(Provides omegaclaw.external.web-search (Provider web-search))
(Provides omegaclaw.external.web-search (Skill web-search))
(Provides omegaclaw.external.web-search (Skill search))
(ExternalInfoCapability web-search current-info)

(OrganPrinciple omegaclaw.external.web-search "Web search observes external information; it does not replace reasoning or memory.")

(RuntimeDependency omegaclaw.external.web-search python ">=3.10")
(RuntimeConfig omegaclaw.external.web-search TAVILY_API_KEY "runtime-secret")

(TraceWrites omegaclaw.external.web-search WebSearchRequested)
(TraceWrites omegaclaw.external.web-search WebSearchResult)
(TraceWrites omegaclaw.external.web-search WebSearchError)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/web_search/src/websearch.py))))
!(import! &self (library OmegaClaw-Core ./modules/web_search/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/web_search/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/web_search/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/web_search/skills.metta))
