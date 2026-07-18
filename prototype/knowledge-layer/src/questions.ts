import type { Question } from "./experiment.js";

/**
 * One question per #52 must-handle class, aimed at the private mail-app target
 * this prototype was run against. All three are about behaviour that product
 * does NOT have yet but plausibly could — so an answer cannot be recited, it
 * has to be placed. Swap them when pointing the prototype at another repo.
 */
export const QUESTIONS: Question[] = [
  {
    id: "q1-placement",
    questionClass: "placement",
    text:
      "Where would a 'mute this thread' feature land — the user marks a conversation and it never surfaces " +
      "in the inbox again, no matter how many replies arrive? Name the files and seams that would have to change.",
  },
  {
    id: "q2-wiring",
    questionClass: "wiring",
    text:
      "How does an email get from the mail provider to the list the user sees today? Walk every hop: what " +
      "authenticates, what fetches, where it is persisted, what turns it into what the UI renders, and what " +
      "triggers a refresh.",
  },
  {
    id: "q3-story-brief",
    questionClass: "story-brief",
    text:
      "Story: 'As a user I want a weekly review on Sunday evening showing what I committed to during the week " +
      "and what I never got to.' Produce a dispatch-ready task brief for a background coding agent: files and " +
      "seams to touch, the approach, constraints it must respect, and the verify gate it must pass.",
  },
];
