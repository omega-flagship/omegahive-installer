"""Private-fork session boundaries for the upstream member-password port."""
from fastapi.testclient import TestClient
import pytest
from hive.core.hive import HiveError, token_hash
from hive.core.visibility import Viewer
from hive.core.me_decisions import human_session
from hive.tests.test_member_passwords import hive, timed, add, login, bearer
from hive.tests import test_local_owner as local_owner_tests
from hive.tests.test_local_owner import local, local_env, _restore_globals


def test_j1_never_hashes_parses_or_writes_for_member_password_requests(local, monkeypatch):
    c = local
    app = c.app
    owner = local_owner_tests.sign_in(c)
    headers = {'Authorization': 'Bearer ' + owner, **local_owner_tests.ORIGIN}
    people = app.state.hive.people
    person_id = app.state.hive.db.one('SELECT id FROM people')['id']
    def forbidden(*args, **kwargs):
        raise AssertionError('J1 reached password code')
    monkeypatch.setattr(people, 'password_hash', forbidden)
    monkeypatch.setattr(people, 'member_for_password', forbidden)
    before = (app.state.hive.db.all('SELECT * FROM people'), app.state.hive.db.all('SELECT * FROM sessions'))
    for method, path in [('POST','/api/auth/login'),('POST','/api/people/members'),
                         ('POST',f'/api/people/{person_id}/password'),('DELETE',f'/api/people/{person_id}/password')]:
        r = c.request(method, path, content='{invalid', headers=headers)
        assert r.status_code == 403, r.text
        assert r.json()['error']['code'] == 'password_signin_off'
    methods = c.get('/api/auth/methods').json()
    assert methods['password'] is False and methods['member_password'] is False
    assert c.get('/api/people', headers=headers).json()['member_passwords'] is False
    assert before == (app.state.hive.db.all('SELECT * FROM people'), app.state.hive.db.all('SELECT * FROM sessions'))


def test_promoted_password_person_has_member_reads_and_no_admin_authority(hive):
    c, admin = hive
    made = add(c, admin)
    token = login(c, made['person']['email'], made['password']).json()['token']
    member = bearer(token)
    principal = 'user:' + made['person']['id']
    assert c.patch('/api/people/' + made['person']['id'], json={'role':'admin'}, headers=admin).status_code == 200
    me = c.get('/api/auth/me', headers=member).json()
    assert me['role'] == 'member' and me['kind'] == 'member_password'
    assert c.get('/api/people', headers=member).status_code == 403
    assert c.get('/api/me/decisions', headers=member).status_code == 200
    assert c.get('/api/me/studio-sessions', headers=member).status_code == 200
    row = c.app.state.hive.db.one('SELECT * FROM sessions WHERE token_hash = ?', (token_hash(token),))
    assert human_session(c.app.state.hive, row, 'member') is True
    with pytest.raises(Exception) as error:
        human_session(c.app.state.hive, row, 'admin')
    assert error.value.status == 401
    view = Viewer(principal, False)
    assert c.app.state.hive.app_ask._person(view, row['token_hash'])['kind'] == 'member_password'
    assert c.app.state.hive.google_connector._session(row) == principal
    other = c.post('/api/swarms', json={'name': 'Operator private flow scope', 'visibility': 'private'}, headers=admin)
    assert other.status_code in (200, 201), other.text
    with pytest.raises(HiveError) as error:
        c.app.state.hive.flows.access(row, other.json()['id'], write=True)
    assert error.value.status in (403, 404)


@pytest.mark.parametrize("kind", ["operator", "known-member", "unknown-member"])
def test_concurrent_guesses_are_counted_before_another_can_be_verified(timed, monkeypatch, kind):
    import asyncio
    import httpx
    import time
    c, admin, _ = timed
    checked = []
    if kind == "operator":
        import hmac
        original = hmac.compare_digest
        def compare(left, right):
            if right == b"pw":
                checked.append(True)
            return original(left, right)
        monkeypatch.setattr(hmac, "compare_digest", compare)
        body = {"password": "wrong"}
    else:
        if kind == "known-member":
            add(c, admin, "ann@x.org")
        def verify(email, password):
            checked.append(email)
            time.sleep(.05)  # verification yields while other HTTP requests reach the same public limiter
            return None
        monkeypatch.setattr(c.app.state.hive.people, "member_for_password", verify)
        body = {"email": "ann@x.org" if kind == "known-member" else "nobody@x.org", "password": "wrong"}
    async def burst():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=c.app), base_url="https://hive.example") as client:
            return await asyncio.gather(*(client.post("/omegahive/api/auth/login", json=body) for _ in range(24)))
    answers = c.portal.call(burst)
    assert sorted(r.status_code for r in answers) == [401, 401] + [429] * 22
    assert len(checked) == 2


@pytest.mark.parametrize('revocation', ['reset', 'remove', 'disable'])
def test_revocation_during_password_verification_cannot_issue_a_new_session(hive, monkeypatch, revocation):
    import asyncio
    import httpx
    import threading
    c, admin = hive
    made = add(c, admin)
    person_id = made['person']['id']
    people = c.app.state.hive.people
    original = people.member_for_password
    checked, release = threading.Event(), threading.Event()
    def suspended_verification(email, password):
        person = original(email, password)
        assert person is not None
        checked.set()
        assert release.wait(10), 'revocation scenario did not release the verified login'
        return person
    monkeypatch.setattr(people, 'member_for_password', suspended_verification)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=c.app), base_url='https://hive.example') as client:
            pending = asyncio.create_task(client.post('/omegahive/api/auth/login', json={
                'email': made['person']['email'], 'password': made['password']}))
            try:
                assert await asyncio.to_thread(checked.wait, 5), 'login did not reach its verification barrier'
                if revocation == 'reset':
                    changed = await client.post(f'/api/people/{person_id}/password', headers=admin)
                elif revocation == 'remove':
                    changed = await client.delete(f'/api/people/{person_id}/password', headers=admin)
                else:
                    changed = await client.patch(f'/api/people/{person_id}', json={'disabled': True}, headers=admin)
                assert changed.status_code == 200, changed.text
            finally:
                release.set()
            return await pending
    answer = c.portal.call(scenario)
    assert answer.status_code == 401, answer.text
    assert answer.json()['error']['code'] == 'unauthorized'
    assert c.app.state.hive.db.all('SELECT * FROM sessions WHERE principal = ? AND kind = ?',
                                  ('user:' + person_id, 'member_password')) == []


def test_public_counter_retention_stays_bounded_for_oversized_typed_identifiers(timed, monkeypatch):
    c, _, _ = timed
    monkeypatch.setattr(c.app.state.hive.people, 'member_for_password', lambda email, password: None)
    email = 'A' * 512_000 + '@example.invalid'
    replies = [c.post('/omegahive/api/auth/login', json={'email': typed, 'password': 'wrong'})
               for typed in (email, email.lower(), email)]
    assert [r.status_code for r in replies] == [401, 401, 429]
    attempts = c.app.state.member_attempts
    assert len(attempts) == 1
    assert sum(len(key) for key in attempts.keys()) <= 64


def test_member_mind_token_obeys_public_google_cutover_and_password_revocation(hive, monkeypatch):
    c, admin = hive
    made = add(c, admin)
    session_token = login(c, made['person']['email'], made['password']).json()['token']
    h = c.app.state.hive
    principal = 'user:' + made['person']['id']
    mind = h.personal.ensure(principal, pick_up=False)
    session_hash = token_hash(session_token)
    raw, _ = h.mind_tokens.mint(principal, mind['id'], session_hash)
    try:
        assert h.mind_tokens.resolve(raw, public=True)['principal'] == principal
        for name in ('client_id', 'client_secret', 'redirect_uri'):
            monkeypatch.setattr(h.people, name, 'configured-for-test')
        assert h.people.google_ready
        with pytest.raises(HiveError) as error:
            h.mind_tokens.resolve(raw, public=True)
        assert error.value.status == 401
        assert h.mind_tokens.resolve(raw, public=False)['principal'] == principal
        removed = c.delete('/api/people/' + made['person']['id'] + '/password', headers=admin)
        assert removed.status_code == 200, removed.text
        with pytest.raises(HiveError) as error:
            h.mind_tokens.resolve(raw, public=False)
        assert error.value.status == 401
    finally:
        h.mind_tokens.revoke_session(session_hash)


def test_failed_logins_do_not_retain_prior_request_frames(monkeypatch):
    import inspect
    from hive.tests.test_member_passwords import make_app
    app = make_app(monkeypatch)
    # The shared fixtures reload core modules; use the actual class registered on this app.
    candidates = [app] + [getattr(route, 'app', None) for route in app.routes]
    target = next(candidate for candidate in candidates if any(
        getattr(t, '__name__', '') == 'HiveError' for t in getattr(candidate, 'exception_handlers', {})))
    error_type = next(t for t in target.exception_handlers if getattr(t, '__name__', '') == 'HiveError')
    original = target.exception_handlers[error_type]
    frame_counts = []
    async def observed(request, error):
        count = 0
        trace = error.__traceback__
        while trace is not None:
            count += trace.tb_frame.f_code.co_name == 'member_login'
            trace = trace.tb_next
        frame_counts.append(count)
        response = original(request, error)
        return await response if inspect.isawaitable(response) else response
    target.add_exception_handler(error_type, observed)
    with TestClient(app, base_url='https://hive.example') as client:
        for _ in range(2):
            response = client.post('/omegahive/api/auth/login', json={'email':'nobody@x.org','password':'wrong'})
            assert response.status_code == 401, response.text
    assert frame_counts == [1, 1], frame_counts
