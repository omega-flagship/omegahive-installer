% Stop cleanly: the hive stops a mind with SIGTERM. SWI's default handler runs on_halt hooks inside the signal,
% and janus then finalises Python underneath a running py_call (usually a model call blocked in recv), which
% segfaulted every local mind on stop (status 139, 22 of 22). Handling TERM at Prolog level lets the call return
% first and then halts normally. Diagnosed and reproduced 2026-10-04 (OmegaEvolve report).
omega_term(_) :- halt(0).
:- on_signal(term, _, omega_term).

shell_risky(Cmd, Reason) :-
    shell_command_segments(Cmd, Segments),
    member(Segment, Segments),
    shell_segment_risky(Segment, Reason), !.

shell_command_segments(Cmd, Segments) :-
    string_chars(Cmd, Chars),
    shell_command_segments_(Chars, none, [], [], RevSegments),
    reverse(RevSegments, Segments).

shell_command_segments_([], _, Current, Segments, Out) :-
    shell_add_segment(Current, Segments, Out).
shell_command_segments_([C|Cs], Quote, Current, Segments, Out) :-
    ( Quote == none, shell_separator(C) ->
        shell_add_segment(Current, Segments, NextSegments),
        shell_command_segments_(Cs, none, [], NextSegments, Out)
    ; Quote == none, shell_quote(C) ->
        shell_command_segments_(Cs, C, [C|Current], Segments, Out)
    ; Quote \== none, C == Quote ->
        shell_command_segments_(Cs, none, [C|Current], Segments, Out)
    ; shell_command_segments_(Cs, Quote, [C|Current], Segments, Out)
    ).

shell_add_segment([], Segments, Segments).
shell_add_segment(Current, Segments, [Segment|Segments]) :-
    reverse(Current, Chars),
    string_chars(Segment, Chars),
    normalize_space(string(Trimmed), Segment),
    Trimmed \= "", !.
shell_add_segment(_, Segments, Segments).

shell_separator(';').
shell_separator('|').
shell_separator('&').
shell_separator('\n').

shell_quote('"').
shell_quote('\'').

shell_segment_risky(Segment, Reason) :-
    split_string(Segment, " \t\n", " \t\n", Tokens),
    shell_tokens_risky(Tokens, Reason).

shell_tokens_risky([Head|_], Head) :-
    member(Head, ["rm", "sudo", "mkfs", "dd", "shutdown", "reboot"]).
shell_tokens_risky(["kill", "-9", "1"|_], "kill -9 1").

shell_run(Cmd, Out) :-
    tmp_file_stream(text, TmpFile, TmpInit),
    close(TmpInit),
    open(TmpFile, write, TmpOut, [type(text)]),
    catch(
        setup_call_cleanup(
            process_create(
                path(timeout),
                ['-k', '1s', '5s', 'sh', '-c', Cmd],
                [ stdout(stream(TmpOut)),
                  stderr(stream(TmpOut)),
                  process(P)
                ]
            ),
            (
                process_wait(P, Status),
                close(TmpOut),
                read_file_to_string(TmpFile, Text, [])
            ),
            (
                catch(close(TmpOut), _, true),
                catch(delete_file(TmpFile), _, true)
            )
        ),
        E,
        (
            catch(close(TmpOut), _, true),
            catch(delete_file(TmpFile), _, true),
            throw(E)
        )
    ),
    ( Status = exit(124) -> Out = timeout_error
    ; Status = exit(137) -> Out = timeout_error
    ; Status = killed(_) -> Out = timeout_error
    ; Out = Text
    ).

% Gets shell command return. Risky commands require explicit shell-confirm.
shell(Cmd, Out) :-
    ( shell_risky(Cmd, Reason) ->
        format(string(Out), "SHELL-RISK command head ~w requires shell-confirm: ~w", [Reason, Cmd])
    ; shell_run(Cmd, Out)
    ).

shell_confirm(Cmd, Out) :-
    shell_run(Cmd, Out).


first_char(Str, C) :- sub_string(Str, 0, 1, _, C).

gc(true) :- garbage_collect,
            garbage_collect_atoms,
            trim_stacks.

read_file_tail(Path, MaxChars, Text) :-
    setup_call_cleanup(
        open(Path, read, In, [type(text), encoding(utf8)]),
        (
            seek(In, 0, eof, End),
            Start is max(0, End - MaxChars),
            seek(In, Start, bof, _),
            read_string(In, _, Text)
        ),
        close(In)
    ).
