# Safe skill adoption

A practical, end-to-end workflow for evaluating an AI agent skill, approving it
deliberately, and noticing when what you approved changes.

*This document is a skeleton. Each section below is a placeholder pending the
lock of [identity-spec.md](identity-spec.md).*

## Overview and trust model

*(section to be written)* — states what this workflow assumes about the reader's
environment, what Sigildex is responsible for, and what remains the reader's
responsibility.

## Discovering candidate skills

*(section to be written)* — how to find candidate skills and what to capture
about each one before spending review effort on it.

## Quarantine staging

*(section to be written)* — fetching a candidate into an isolated directory that
no agent or runtime is configured to load, so that review happens before
execution.

## Scanning and manual review

*(section to be written)* — combining automated scanning with a deliberate human
read of the staged artifact.

Manual review checklist *(to be written)*:

- What the skill instructs the agent to do, in its own words.
- Which tools and permissions it requests.
- Bundled scripts and any executable content.
- Dependencies and install commands.
- Credential, network, and file access.
- Remote instructions or resources that may change after review.
- Proportionality: whether the requested capability matches the stated purpose.

## Recording an approval

*(section to be written)* — capturing the reviewed state as an approval record,
and what that record does and does not assert.

## Install and verify

*(section to be written)* — moving the approved artifact out of quarantine and
confirming that what was installed is what was approved.

## Enforcing approvals in CI

*(section to be written)* — running the check as a gate so that unapproved or
drifted skills fail the build rather than reaching an agent.

## Checking approved skills for updates

*(section to be written)* — noticing upstream change without granting it
automatic trust.

- On-demand checks.
- An optional scheduled, read-only workflow.
- Staging update candidates in quarantine before adoption.
- Trackable versus pinned installation strategies.

## Adopting an already-installed skill

*(section to be written)* — bringing skills that predate this workflow under an
approval record without reinstalling them.

## Removal, emergency revocation, and rollback

*(section to be written)* — withdrawing an approval quickly, and returning to a
known-good prior state.

## What an approval record cannot freeze

*(section to be written)* — the boundaries of the guarantee, stated plainly.

- Mutable remote instructions fetched at runtime.
- Unpinned dependencies.
- External APIs and services.
- Install-time behavior.
- Runtime environment changes.
- Credentials granted by the agent harness.
