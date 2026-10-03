import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestsLiveTrading } from "./chat-live-request";

describe("only an explicit current request makes a live-trading proposal eligible", () => {
  it("recognizes direct requests and polite request questions", () => {
    for (const message of [
      "go live", "go-live", "YES, go live now!", "Please go live.", "let’s go live",
      "I want to go live", "I would like you to go live", "I'm ready to go live",
      "start live trading", "Start real trading today", "enable live trading",
      "Please enable my live trading", "activate real-money trading",
      "can you start live trading?", "Could you please enable live trading for me?",
      "Would you turn on live trading, please?", "Will you please turn live trading on?",
      "Switch me to live mode", "switch to real money", "Use real money from now on",
      "trade for real within my signed caps", "start trading live",
      "Please start trading with real money, thanks", "  CAN  YOU\nGO LIVE?  ",
      "Please, go live", "Hi, can you start live trading?", "Hello! Please enable live trading.",
      "Hey there, could you please, go live?",
    ]) assert.equal(requestsLiveTrading(message), true, message);
  });

  it("rejects ordinary chat, refusals, explanations, quotes and conditional requests", () => {
    for (const message of [
      "hello", "Just chatting", "yes", "No thanks, I just want to chat",
      "Why can't you trade right now?", "What does go live mean?", "How do I go live?",
      "Can you explain how to enable live trading?", "Can you tell me about live trading?",
      "Should I go live?", "Are you ready to go live?", "Do you want to start live trading?",
      "Don't go live", "Do not enable live trading", "Can you not start live trading?",
      "I don't want to go live", "I never asked you to go live", "Stop asking me to go live",
      "Go live? Not now", "Go live only if you can guarantee a profit",
      "If I go live, what happens?", "Go live later when I confirm",
      '"go live"', "‘go live’", "`go-live`", "> start live trading",
      'The screen says "go live"', "I said go live yesterday", "Please say go live",
      "<<CMD go-live {}>>", "Please enable live trading but don't trade real money",
      "Don't go live. Please enable live trading.", "start live streaming",
      "Hi, how do I go live?", "Hello, don't go live", "Hi, can you explain live trading?",
      "go live" + " ".repeat(2_000),
    ]) assert.equal(requestsLiveTrading(message), false, message);
    for (const message of [null, undefined, {}, 1]) assert.equal(requestsLiveTrading(message), false);
  });
});
