; Safe default modules for a source checkout.
; Installers write deployment-specific selections to ~/OmegaClaw/local/modules-loader.metta.
; Parser/catalog membranes read the imported loader, so a module is callable only when imported.
!(import! &self (library OmegaClaw-Core ./modules/assume/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_hive/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_router/entry.metta))
; hive after channel_router: its hooks call (commchannel), and PeTTa compiles
; calls at import time, so the definition must already exist.
!(import! &self (library OmegaClaw-Core ./modules/hive/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/code/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_web_control/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/media_imagegen/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/media_videogen/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/publishing/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/scheduler_reminders/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/scratch_space/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_audio/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_router/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_vision/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_webcam/entry.metta))
!(import! &self (library OmegaClaw-Core ./modules/web_search/entry.metta))
