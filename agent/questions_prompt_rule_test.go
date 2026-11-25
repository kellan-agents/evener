package agent

import (
	"strings"
	"testing"
)

// TestSystemPromptQuestionsRuleAskUserOnly pins the no-prose-questions rule
// in the Questions section: a turn that needs an answer must end with an
// ask_user call, never with a question written in the turn-ending text.
// Prose questions mark nothing in the hub (the photo-upload handoff stall,
// 2026-11-25), so the prompt is the only place the rule can live.
func TestSystemPromptQuestionsRuleAskUserOnly(t *testing.T) {
	s := newSession(t, withConfig(SessionConfig{MaxSubagentDepth: 1}))
	prompt, warning, renderFailed := s.renderSystemPrompt(s.env)
	if warning != "" || renderFailed {
		t.Fatalf("render failed: %s", warning)
	}
	if !strings.Contains(prompt, "never with a question in the text") {
		t.Fatal("Questions section is missing the no-prose-questions rule")
	}
	if !strings.Contains(prompt, "Send it with `ask_user`") {
		t.Fatal("Questions table is missing the skill-template row")
	}
}
