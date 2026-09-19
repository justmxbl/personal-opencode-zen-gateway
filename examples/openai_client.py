"""Example: use the OpenCode Zen Gateway with the official OpenAI client.

    pip install openai
    python examples/openai_client.py
"""

import os

from openai import OpenAI

client = OpenAI(
    base_url=os.environ.get("OZG_BASE_URL", "http://127.0.0.1:8899/v1"),
    api_key=os.environ.get("OZG_API_KEY", "not-needed"),
)

# 1. list the free models
print("=== models ===")
for model in client.models.list().data:
    print(f"  {model.id}")

# 2. a simple completion
print("\n=== non-streaming ===")
response = client.chat.completions.create(
    model="mimo-v2.5-free",
    messages=[{"role": "user", "content": "Reply with exactly: hello from the gateway"}],
)
print(response.choices[0].message.content)

# 3. streaming
print("\n=== streaming ===")
stream = client.chat.completions.create(
    model="mimo-v2.5-free",
    messages=[{"role": "user", "content": "Count from 1 to 5, comma separated."}],
    stream=True,
)
text = ""
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        text += chunk.choices[0].delta.content
print(text)

# 4. multi-turn with a system prompt
print("\n=== multi-turn ===")
response = client.chat.completions.create(
    model="big-pickle",
    messages=[
        {"role": "system", "content": "You are a concise assistant."},
        {"role": "user", "content": "My name is Alex."},
        {"role": "assistant", "content": "Hello Alex!"},
        {"role": "user", "content": "What is my name?"},
    ],
)
print(response.choices[0].message.content)
