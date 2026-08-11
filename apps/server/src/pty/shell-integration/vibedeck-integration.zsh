# vibedeck shell integration — OSC 133 command-block markers.
#
# This file is sourced (never copied into a real dotfile — see zdotdir.ts's
# top comment for the ZDOTDIR trick that gets it loaded without touching the
# user's own ~/.zshrc) by the generated .zshrc inside vibedeck's throwaway
# ZDOTDIR. Its only job: print four small, invisible-to-the-eye escape
# sequences ("OSC 133") that let the vibedeck terminal UI figure out where
# each command starts and ends, and whether it succeeded — without that,
# a terminal only ever sees one long undifferentiated stream of characters.
#
#   ESC ] 133 ; A BEL   — a new prompt is about to be drawn
#   ESC ] 133 ; B BEL   — the prompt finished drawing; user input starts here
#   ESC ] 133 ; C BEL   — the typed command just started executing
#   ESC ] 133 ; D ; N BEL — the command finished, exit code N
#
# This is a de facto standard (also used by VS Code's, iTerm2's, and
# WezTerm's own shell integrations) — vibedeck isn't inventing it, just
# implementing our own reading of it in zsh.

# Guard against being sourced somewhere that isn't actually zsh (harmless,
# but no point running zsh-only hook machinery if it somehow got sourced
# from a different shell).
if [[ -n "$ZSH_VERSION" ]]; then

# Fires right before zsh actually executes a typed command — this is the
# "C" (command-started) marker.
_vibedeck_preexec() {
  printf '\033]133;C\007'
}

# Fires right before the NEXT prompt is drawn, i.e. right after the
# previous command finished. `$?` here is still that command's real exit
# code — grabbing it into `ret` as the very first statement matters,
# because printf/local themselves would otherwise reset `$?` before we get
# a chance to read it.
_vibedeck_precmd() {
  local ret=$?
  printf '\033]133;D;%s\007' "$ret"
  printf '\033]133;A\007'
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _vibedeck_preexec
add-zsh-hook precmd _vibedeck_precmd

# Mark the END of the prompt (right before the user's typed input begins).
# This is APPENDED after the real prompt text ($PS1), not prepended — B
# means "the prompt text is done printing, whatever comes next on this line
# is what the user types," so it has to come AFTER "harsha@host %", not
# before it. (Getting this backwards was caught by hand-testing: with B
# prepended, Terminal.tsx's command-text capture — which reads everything
# after the column B fired at — captured the WHOLE line "harsha@host % ls"
# instead of just "ls", because column 0 is where B fired.)
#
# The `%{...%}` wrapper is zsh's "this is a zero-width escape, don't count
# it toward the prompt's visible width" — without it, zsh would think the
# invisible marker bytes are real printable characters, and a long or
# wrapped prompt would wrap in the wrong place.
PS1="$PS1%{$(printf '\033]133;B\007')%}"

fi
