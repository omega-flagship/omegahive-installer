"""Synthetic ProviderStore + real Gateway.chat transport controls; Source-only until admitted.

All 19 historical method IDs are retained; "connected" in old test names is historical.
Assertions distinguish legacy configured/connected from current answer_ready/readiness.
No application startup, DB, real provider, background probe or budget bypass is exercised.
Every upstream uses httpx.MockTransport; temporary keyrings contain invented test values.
"""
import asyncio
import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from hive.core.config import Provider
from hive.core.gateway import Gateway, GatewayError
from hive.core.providers import ANSWER_TTL, ProviderStore


class ProviderAnswerReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.providers = {
            'local': Provider('local', 'http://127.0.0.1:8000/v1', local=True, models=['demo']),
            'mock': Provider('mock', local=True, models=['echo']),
            'openai': Provider('openai', 'https://provider.invalid/v1', models=['demo']),
            'openrouter': Provider('openrouter', 'https://catalog.invalid/v1', models=['demo']),
        }
        self.settings = SimpleNamespace(data_dir=self.tmp.name, providers=self.providers, default_model='local/demo')
        self.calls = []
        self.mode = 'answer'
        self.tool_arguments = '{}'
        self.mutate = None
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(self.upstream), trust_env=False)
        self.addAsyncCleanup(self.client.aclose)
        self.store = ProviderStore(self.settings, self.client)
        self.now = 100.0
        self.store._answer_clock = lambda: self.now
        self.gateway = Gateway(self.providers)
        await self.gateway.client.aclose()
        self.gateway.client = self.client
        self.gateway.keyring = self.store

    async def upstream(self, request):
        self.calls.append((request.method, request.url.path))
        if self.mutate is not None:
            self.mutate()
        if request.method == 'GET':
            return httpx.Response(200, json={'data': []})
        if self.mode == 'down':
            raise httpx.ConnectError('synthetic connection failure', request=request)
        if self.mode == 'pool':
            raise httpx.PoolTimeout('synthetic local pool wait', request=request)
        if self.mode == 'cancel':
            raise asyncio.CancelledError()
        if self.mode == 'denied':
            return httpx.Response(401, json={'error': 'synthetic rejection'})
        if self.mode == 'invalid_json':
            return httpx.Response(200, content=b'not-json')
        if self.mode == 'nonobject':
            return httpx.Response(200, json=[])
        malformed_usage = {
            'usage_list': ['synthetic'], 'usage_string': 'synthetic',
            'bad_token': {'prompt_tokens': 'not-an-integer'},
            'null_token': {'completion_tokens': None},
        }
        if self.mode in malformed_usage:
            return httpx.Response(200, json={'choices': [], 'usage': malformed_usage[self.mode]})
        if self.mode == 'bad_cost':
            self.providers['local'].prices = {'demo': {'in': 'not-a-price', 'out': 0}}
            return httpx.Response(200, json={'choices': [], 'usage': {'prompt_tokens': 1}})
        if self.mode == 'empty':
            return httpx.Response(200, json={'choices': []})
        message = {'role': 'assistant', 'content': 'Synthetic model answer'}
        if self.mode in ('tool', 'tool_text'):
            message = {'role': 'assistant', 'content': 'Synthetic text answer' if self.mode == 'tool_text' else None, 'tool_calls': [
                {'id': 'synthetic-call', 'type': 'function', 'function': {'name': 'demo', 'arguments': self.tool_arguments}}]}
        return httpx.Response(307 if self.mode == 'redirect' else 200, json={'choices': [{'message': message}],
                                       'usage': {'prompt_tokens': 1, 'completion_tokens': 1}})

    async def chat(self, provider='local', options=None, body=None):
        agent = {'id': 'synthetic-agent-id', 'name': 'Synthetic mind', 'model': provider + '/demo', 'options': options or {}}
        return await self.gateway.chat(agent, body or {'messages': [{'role': 'user', 'content': 'Synthetic request'}]})

    def assert_status(self, name, connected, readiness):
        result = self.store.status(name)
        self.assertIs(result['connected'], connected)
        self.assertIs(result['configured'], connected)
        self.assertIs(result['answer_ready'], readiness == 'answered')
        self.assertEqual(result['readiness'], readiness)
        self.assertIs(result['test_only'], name == 'mock')
        return result

    async def test_fresh_without_key_or_local_answer_is_todo_without_io(self):
        self.assert_status('local', True, 'unverified')
        self.assert_status('mock', True, 'test_only')
        self.assert_status('openai', False, 'unverified')
        rows = self.store.list()
        self.assertFalse(any(v['answer_ready'] for v in rows))
        self.assertEqual({v['name']: v['connected'] for v in rows},
                         {'local': True, 'mock': True, 'openai': False, 'openrouter': False})
        self.assertTrue(all(v['configured'] == v['connected'] for v in rows))
        self.providers['openai'].key_env = 'SYNTHETIC_OPENAI_KEY'
        os.environ['SYNTHETIC_OPENAI_KEY'] = 'synthetic-env-credential'
        self.assert_status('openai', True, 'unverified')
        del os.environ['SYNTHETIC_OPENAI_KEY']
        self.assert_status('openai', False, 'unverified')
        self.assertEqual(self.calls, [])
        self.providers.pop('local')
        self.assertFalse(any(v['answer_ready'] for v in self.store.list()))
        self.assertEqual(self.calls, [])

    async def test_local_down_is_not_answering_only_after_actual_attempt(self):
        self.mode = 'down'
        with self.assertRaises(httpx.ConnectError):
            await self.chat()
        self.assert_status('local', True, 'not_answering')
        self.assertEqual(self.calls, [('POST', '/v1/chat/completions')])

    async def test_local_answer_connects_and_repeated_status_does_not_probe(self):
        data, usage = await self.chat()
        self.assertEqual(data['choices'][0]['message']['content'], 'Synthetic model answer')
        self.assertEqual(usage['cost_usd'], 0.0)
        for _ in range(3):
            self.assert_status('local', True, 'answered')
            self.store.list()
        self.assertEqual(self.calls, [('POST', '/v1/chat/completions')])
        self.assertNotIn('Synthetic model answer', repr(self.store._answers))
        restarted = ProviderStore(self.settings, self.client)
        self.assertEqual(restarted._answers, {})
        self.assertIs(restarted.status('local')['connected'], True)
        self.assertIs(restarted.status('local')['configured'], True)
        self.assertIs(restarted.status('local')['answer_ready'], False)
        self.assertEqual(restarted.status('local')['readiness'], 'unverified')
        self.assert_status('local', True, 'answered')
        self.assertEqual(self.calls, [('POST', '/v1/chat/completions')])

    async def test_tool_answer_is_evidence_without_executing_a_tool(self):
        valid = ('{}', '{"q": "synthetic"}', '[]', 'null', '0', 'false', '"synthetic"',
                 '"NaN"', '"Infinity"', '"-Infinity"', '{"label":"NaN","other":["Infinity","-Infinity"]}')
        invalid = ('', '   ', 'not-json', '{', None, {}, [],
                   'NaN', 'Infinity', '-Infinity', '{"x":NaN}', '[Infinity]', '{"nested":[{"x":-Infinity}]}')
        for arguments in valid:
            with self.subTest(valid_arguments=arguments):
                self.mode, self.tool_arguments = 'tool', arguments
                await self.chat()
                self.assert_status('local', True, 'answered')
        for arguments in invalid:
            with self.subTest(invalid_arguments=arguments):
                self.mode = 'answer'
                await self.chat()
                self.assert_status('local', True, 'answered')
                self.mode, self.tool_arguments = 'tool', arguments
                await self.chat()
                self.assert_status('local', True, 'not_answering')
        # Malformed tool arguments do not discard independently valid assistant text.
        self.mode, self.tool_arguments = 'tool_text', '{"nested":NaN}'
        await self.chat()
        self.assert_status('local', True, 'answered')
        self.assertEqual(len(self.calls), len(valid) + 2 * len(invalid) + 1)

    async def test_mock_is_always_test_only_and_never_connected(self):
        await self.chat('mock')
        self.assert_status('mock', True, 'test_only')
        self.assertEqual(self.calls, [])

    async def test_expired_or_backwards_clock_does_not_claim_current_answer(self):
        await self.chat()
        self.now += ANSWER_TTL - .001
        self.assert_status('local', True, 'answered')
        self.now += .001
        self.assert_status('local', True, 'unverified')
        self.now = 99.0
        self.assert_status('local', True, 'unverified')
        self.assertEqual(len(self.calls), 1)

    async def test_url_models_default_model_and_provider_replacement_invalidate(self):
        changes = (
            lambda: setattr(self.providers['local'], 'base_url', 'http://127.0.0.1:9000/v1'),
            lambda: self.providers['local'].models.append('other'),
            lambda: setattr(self.settings, 'default_model', 'local/other'),
            lambda: self.providers.update(local=Provider('local', 'http://127.0.0.1:8000/v1', local=True, models=['demo'])),
        )
        for change in changes:
            with self.subTest(change=changes.index(change)):
                await self.chat()
                self.assert_status('local', True, 'answered')
                change()
                self.assert_status('local', True, 'unverified')
        self.assertEqual(len(self.calls), 4)

    async def test_observed_config_change_cannot_revive_old_answer_when_restored(self):
        await self.chat()
        original = self.providers['local'].base_url
        self.providers['local'].base_url = 'http://127.0.0.1:9000/v1'
        self.assert_status('local', True, 'unverified')
        self.providers['local'].base_url = original
        self.assert_status('local', True, 'unverified')
        await self.chat()
        self.assert_status('local', True, 'answered')
        self.assertEqual(len(self.calls), 2)

    async def test_config_change_during_request_cannot_validate_new_route(self):
        self.mutate = lambda: setattr(self.providers['local'], 'base_url', 'http://127.0.0.1:9000/v1')
        await self.chat()
        self.assert_status('local', True, 'unverified')
        self.assertEqual(len(self.calls), 1)

    async def test_key_verification_and_catalogue_never_mean_model_answered(self):
        await self.store.set_key('openai', 'synthetic-test-credential-one')
        self.assert_status('openai', True, 'unverified')
        await self.store.account('openai')
        await self.store.models(refresh=True)
        self.assert_status('openai', True, 'unverified')
        self.assert_status('openrouter', False, 'unverified')
        self.assertTrue(all(method == 'GET' for method, _ in self.calls))

    async def test_remote_default_key_requires_answer_then_rotation_invalidates(self):
        await self.store.set_key('openai', 'synthetic-test-credential-one')
        self.assert_status('openai', True, 'unverified')
        await self.chat('openai')
        self.assert_status('openai', True, 'answered')
        await self.store.set_key('openai', 'synthetic-test-credential-two')
        self.assert_status('openai', True, 'unverified')
        self.assertEqual(sum(method == 'POST' for method, _ in self.calls), 1)
        self.assertNotIn('synthetic-test-credential-one', repr(self.store._answers))
        with self.subTest(change='same-value-default-id'):
            await self.chat('openai')
            self.assert_status('openai', True, 'answered')
            original_id = self.store.ring['defaults']['openai']
            other_id = 'k_ffffffff' if original_id != 'k_ffffffff' else 'k_00000000'
            # Duplicate values are seeded only in the synthetic retained-ring fixture;
            # normal add_key correctly rejects duplicate secrets.
            self.store.ring['keys'][other_id] = dict(self.store.ring['keys'][original_id], id=other_id)
            original_secret = self.providers['openai'].api_key
            self.store.update_key(other_id, default=True)
            self.assertEqual(self.providers['openai'].api_key, original_secret)
            self.assertEqual(self.store.ring['defaults']['openai'], other_id)
            self.assert_status('openai', True, 'unverified')
            self.store.update_key(original_id, default=True)
            self.assert_status('openai', True, 'unverified')
            await self.chat('openai')
            self.assert_status('openai', True, 'answered')
        with self.subTest(change='same-value-default-id-during-request'):
            self.mutate = lambda: self.store.update_key(other_id, default=True)
            await self.chat('openai')
            self.mutate = None
            self.assertEqual(self.providers['openai'].api_key, original_secret)
            self.assert_status('openai', True, 'unverified')
            await self.chat('openai')
            self.assert_status('openai', True, 'answered')
        self.assertEqual(sum(method == 'POST' for method, _ in self.calls), 5)
        self.assertNotIn(original_secret, repr(self.store._answers))

    async def test_nondefault_person_key_does_not_validate_hive_default(self):
        await self.store.set_key('openai', 'synthetic-test-credential-one')
        second = await self.store.add_key('openai', 'synthetic-test-credential-two', make_default=False)
        await self.chat('openai', options={'key': second['id']})
        self.assert_status('openai', True, 'unverified')
        await self.chat('openai')
        self.assert_status('openai', True, 'answered')
        self.assertEqual(sum(method == 'POST' for method, _ in self.calls), 2)
        self.store.update_key(self.store.ring['defaults']['openai'], default=False)
        self.assertEqual(self.providers['openai'].api_key, '')
        self.assert_status('openai', True, 'unverified')

    async def test_observed_failure_replaces_prior_success_and_recovery_is_explicit(self):
        await self.chat()
        self.mode = 'denied'
        with self.assertRaises(GatewayError):
            await self.chat()
        self.assert_status('local', True, 'not_answering')
        self.assertEqual(len(self.calls), 2)
        self.mode = 'answer'
        await self.chat()
        self.assert_status('local', True, 'answered')
        self.assertEqual(len(self.calls), 3)

    async def test_non2xx_response_cannot_refresh_answer_even_with_assistant_body(self):
        await self.chat()
        self.assert_status('local', True, 'answered')
        self.mode = 'redirect'
        data, _ = await self.chat()  # preserve existing Gateway caller behavior
        self.assertEqual(data['choices'][0]['message']['role'], 'assistant')
        self.assert_status('local', True, 'not_answering')
        self.assertEqual(len(self.calls), 2)

    async def test_invalid_json_and_empty_answer_are_not_connected(self):
        for mode in ('invalid_json', 'nonobject', 'empty'):
            with self.subTest(mode=mode):
                await self.chat()
                self.mode = mode
                if mode == 'invalid_json':
                    with self.assertRaises(ValueError):
                        await self.chat()
                elif mode == 'nonobject':
                    with self.assertRaises(AttributeError):
                        await self.chat()
                else:
                    await self.chat()
                self.assert_status('local', True, 'not_answering')
                self.mode = 'answer'
        self.assertEqual(len(self.calls), 6)

    async def test_malformed_usage_or_cost_invalidates_prior_answer_and_preserves_error(self):
        cases = (('usage_list', AttributeError), ('usage_string', AttributeError),
                 ('bad_token', ValueError), ('null_token', TypeError), ('bad_cost', ValueError))
        for mode, expected in cases:
            with self.subTest(mode=mode):
                self.providers['local'].prices = {}
                self.mode = 'answer'
                await self.chat()
                self.assert_status('local', True, 'answered')
                self.mode = mode
                with self.assertRaises(expected):
                    await self.chat()
                self.assert_status('local', True, 'not_answering')
        self.assertEqual(len(self.calls), 2 * len(cases))

    async def test_policy_refusal_before_request_does_not_mark_provider_down(self):
        await self.chat()
        def refuse(_):
            raise GatewayError(403, 'synthetic_policy', 'synthetic refusal')
        self.gateway.authorize_agent = refuse
        with self.assertRaises(GatewayError):
            await self.chat()
        self.assert_status('local', True, 'answered')
        self.assertEqual(len(self.calls), 1)

    async def test_cancellation_and_pool_wait_do_not_mark_provider_down(self):
        await self.chat()
        self.mode = 'pool'
        with self.assertRaises(httpx.PoolTimeout):
            await self.chat()
        self.assert_status('local', True, 'answered')
        self.mode = 'cancel'
        with self.assertRaises(asyncio.CancelledError):
            await self.chat()
        self.assert_status('local', True, 'answered')
        self.assertEqual(len(self.calls), 3)

    async def test_stream_refusal_preserves_existing_no_request_behavior(self):
        with self.assertRaises(GatewayError) as raised:
            await self.chat(body={'stream': True})
        self.assertEqual(raised.exception.code, 'stream_unsupported')
        self.assert_status('local', True, 'unverified')
        self.assertEqual(self.calls, [])
