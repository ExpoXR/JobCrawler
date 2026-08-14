# Memory Skill

## Purpose

Persist and recall important information across Claude Code sessions.

## Behavior

When this skill is active, Claude will:

1. **Remember** key decisions, preferences, and context from conversations
2. **Recall** relevant past context when starting new sessions
3. **Update** stored knowledge when information changes

## Storage

Memory entries are stored as structured notes in this skill directory.

## Usage

Invoke with `/memory` or when context persistence is needed.

### Commands

- `remember [info]` - Store a piece of information
- `recall [topic]` - Retrieve stored information about a topic
- `forget [topic]` - Remove stored information about a topic
- `list` - Show all stored memories
