# AI Agent Invocation Workflow

## Overview

The **AI Agent Invocation** workflow automates running tasks requested via issue comments. When a comment containing `!agent` is posted, the workflow triggers an AI-powered agent to generate branches, create or update files, and open pull requests automatically. It uses OpenAI for task planning and Octokit to interact with GitHub repositories.

This workflow is ideal for automating repetitive development tasks, code scaffolding, or AI-assisted feature creation directly from issue comments.

---

## Features

* Triggered via issue comments (`!agent`).
* Generates branches, files, and PRs automatically using AI.
* Reads repository context including `ReadMe.md`, database schema, and architecture maps.
* Checks if a branch exists and is up-to-date:

  * Updates branch if up-to-date.
  * Deletes and recreates if behind main.
* Overwrites existing files in case of conflicts.
* Posts changes via a pull request.

---

## Workflow Trigger

The workflow is triggered on **issue comments**:

```yaml
on:
  issue_comment:
    types: [created]
```

It only runs if the comment contains the `!agent` keyword:

```yaml
if: contains(github.event.comment.body, '!agent')
```

---

## Permissions

Required permissions:

```yaml
permissions:
  contents: write         # Read/write repository files
  issues: write           # Read/write issue comments
  pull-requests: write    # Create and update PRs
```

---

## Setup and Dependencies

The workflow runs on **Node.js 20** and uses the following packages:

* `openai@4` → AI planning for tasks.
* `@octokit/rest` → GitHub API interactions.
* `axios`, `glob`, `js-yaml`, `path` → Utilities for handling files and requests.

Dependencies are installed with:

```bash
npm install openai@4 axios glob js-yaml @octokit/rest path
```

---

## Environment Variables

You need the following secrets set in your repository:

* `OPENAI_API_KEY` → OpenAI API key.
* `PAT_TOKEN` → GitHub Personal Access Token (with repo access) for actions that require elevated permissions.

---

## How It Works

1. **Checkout Repository**
   Uses `actions/checkout@v4` to clone the repository locally.

2. **Read Repository Context**
   The agent reads:

   * `ReadMe.md` → Project description.
   * `WorkflowData/architecture_map.json` → System architecture mapping.
   * `WorkflowData/schema.json` → Database schema.

3. **AI Task Planning**
   The AI receives the context and the issue comment task. It outputs a JSON object containing:

   * Branch name
   * Files to create/update
   * PR title and body

4. **Branch Management**

   * Checks if the branch exists.
   * If up-to-date with main → updates files in place.
   * If behind main → deletes and recreates the branch from main.

5. **File Updates**

   * Existing files are overwritten if conflicts occur.
   * File content is uploaded to the branch in base64 format.

6. **Pull Request Creation**
   A PR is created automatically with the AI-generated branch, including the suggested title and body.

---

## Customization

### 1. Trigger Keyword

Change the trigger keyword by modifying the `if` condition in the workflow:

```yaml
if: contains(github.event.comment.body, '!agent')
```

### 2. AI Prompt and Context

Modify `runTask.js` to include additional context files or different AI instructions:

```js
const readme = fs.readFileSync(path.resolve(ROOT, "ReadMe.md"), "utf8");
const map = fs.readFileSync(path.resolve(ROOT, "WorkflowData/architecture_map.json"), "utf8");
const db_data = fs.readFileSync(path.resolve(ROOT, "WorkflowData/schema.json"), "utf8");
```

### 3. Branch Strategy

The workflow currently:

* Updates branch if up-to-date.
* Deletes and recreates if behind main.

You can modify this logic to suit your branching strategy.

### 4. AI Model

Change the OpenAI model as needed:

```js
const ai = await openai.chat.completions.create({
  model: "gpt-4.1",
  messages: [...]
});
```

### 5. File Overwriting

Currently, files with conflicts are overwritten. You can add custom logic to merge changes instead of replacing.

---

## Usage

1. Comment on an issue with `!agent <task description>`.
2. The workflow will trigger automatically.
3. The AI generates a branch, creates/updates files, and opens a pull request.
4. Review the pull request and merge if ready.

---

## Notes & Best Practices

* Ensure the `PAT_TOKEN` has sufficient permissions for branch creation and PRs.
* Use descriptive tasks in comments for better AI outputs.
* Keep context files (`ReadMe.md`, `architecture_map.json`, `schema.json`) up-to-date for accurate AI guidance.
* Limit task scope per comment for manageable AI-generated changes.

