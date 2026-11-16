% Register the existing Hive checkout under its historical PeTTa library name.
% Installation, not agent startup, obtains repositories. Never download an old core.
'register-hive-core'(true) :-
    Root = './repos/OmegaClaw-Core',
    directory_file_path(Root, 'core-dependency.json', Lock),
    ( exists_file(Lock) -> asserta(library_path(Root))
    ; throw(error(existence_error(hive_core_dependency, Lock),
                  context('register-hive-core'/1, 'Run the Hive installer and scripts/setup_core.py')))
    ).
