import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from harness.combat import dataset


REPO = Path(__file__).resolve().parents[1]
RECORD = """
import { Recorder } from './bridge/recording.js';
import { emptyAction } from './bridge/arbiter.js';
import { buildObservation } from './bridge/observation.js';
import path from 'node:path';
const bot = {entity:{position:{x:0,y:64,z:0},velocity:{x:0,y:0,z:0},yaw:0,pitch:0,onGround:true},health:20,food:20};
for (const agent of ['Alpha', 'Beta']) {
  const recorder = new Recorder({dataDir:path.join(process.argv[1],agent),sessionId:'play',target:'zombie',environmentLabel:'arena-east'});
  recorder.start();
  for (let tick=0;tick<2;tick++) recorder.row(buildObservation(bot),emptyAction(),emptyAction(),{source:'teacher',reason:'teacher'},1000+tick*50);
  recorder.setLabel('good');
  recorder.stop();
}
"""


class DatasetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        subprocess.run(['node', '--input-type=module', '-e', RECORD, str(self.root)], cwd=REPO, check=True, capture_output=True, text=True)
        self.sessions = [self.root / agent / 'play' for agent in ('Alpha', 'Beta')]
        # Deliberately reuse an encounter ID across agents to catch accidental merging.
        for session in self.sessions:
            original = next((session / 'encounters').glob('*.jsonl'))
            rows = [json.loads(line) for line in original.read_text().splitlines()]
            original.unlink()
            for row in rows:
                row['encounter_id'] = 'shared'
            self.write_rows(session, rows)

    def write_rows(self, session, rows):
        (session / 'encounters' / 'shared.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')

    def rows(self, session):
        return [json.loads(line) for line in (session / 'encounters' / 'shared.jsonl').read_text().splitlines()]

    def test_accepts_actual_recorder_output(self):
        for session in self.sessions:
            result = dataset.validate_session(session)
            self.assertTrue(result.valid, result.errors)
            self.assertEqual(result.environment, 'open_surface')
            self.assertEqual(result.rows, 2)
            self.assertEqual(dataset.action_vector(self.rows(session)[0])[-1], 0, 'missing disengage defaults to false')

    def test_discovers_agents_without_merging_encounters_and_preserves_metadata(self):
        for session, agent in zip(self.sessions, ('Alpha', 'Beta')):
            rows = self.rows(session)
            for row in rows:
                row.update(agent_name=agent, controller_id='connection-' + agent, server_time_ms=row['timestamp_ms'])
            self.write_rows(session, rows)
            (session / 'encounters' / 'empty.jsonl').touch()
        encounters = list(dataset.iter_encounters(self.root))
        self.assertEqual([session for session, _ in encounters], self.sessions)
        for session, rows in encounters:
            self.assertEqual(rows, self.rows(session))
            self.assertEqual(len(rows), 2)

    def test_legacy_session_and_single_session_input_still_work(self):
        session = self.sessions[0]
        metadata_file = session / 'session.json'
        metadata = json.loads(metadata_file.read_text())
        metadata['environment'] = metadata.pop('environment_suite')
        metadata_file.write_text(json.dumps(metadata), encoding='utf-8')
        rows = self.rows(session)
        for row in rows:
            row['teacher_action']['disengage'] = False
            row['applied_action']['disengage'] = False
        self.write_rows(session, rows)
        self.assertTrue(dataset.validate_session(session).valid)
        self.assertEqual(list(dataset.iter_encounters(session)), [(session, rows)])

    def test_current_terrain_summaries_and_legacy_terrain_are_read(self):
        row = self.rows(self.sessions[0])[0]
        row['observation']['terrain'].update(drop_forward=3, clearance_forward=0, hazard_near=0)
        values = dict(zip(dataset.DEFAULT_FEATURES, dataset.feature_vector(row)))
        self.assertEqual(values['drop_forward'], 3)
        self.assertEqual(values['clearance_forward'], 0)
        self.assertEqual(values['hazard_near'], 0)
        legacy = {'observation': {'terrain': {'support_grid': {'forward': .5}, 'drop_depth': {'right': 4}, 'clearance': {'right': 2}, 'hazards': True}}}
        values = dict(zip(dataset.DEFAULT_FEATURES, dataset.feature_vector(legacy)))
        self.assertEqual([values[key] for key in ('support_forward', 'drop_right', 'clearance_right', 'hazard_near')], [.5, 4, 2, 1])
        contract = json.loads((REPO / 'contracts' / 'policy.json').read_text())
        self.assertEqual(dataset.DEFAULT_FEATURES, contract['features'])
        self.assertEqual(dataset.OUTPUTS, contract['outputs'])

    def test_invalid_optional_metadata_is_rejected(self):
        session = self.sessions[0]
        for key, value in [('agent_name', 12), ('controller_id', ''), ('server_time_ms', True)]:
            with self.subTest(field=key):
                rows = self.rows(session)
                rows[0][key] = value
                self.write_rows(session, rows)
                self.assertTrue(any(key in error for error in dataset.validate_session(session).errors))
                rows[0].pop(key)
                self.write_rows(session, rows)

    def test_null_optional_metadata_and_existing_validation_rules(self):
        session = self.sessions[0]
        rows = self.rows(session)
        rows[0].update(agent_name=None, controller_id=None, server_time_ms=None)
        self.write_rows(session, rows)
        self.assertTrue(dataset.validate_session(session).valid)
        rows[0]['schema_version'] = 2
        self.write_rows(session, rows)
        self.assertFalse(dataset.validate_session(session).valid)
        rows[0]['schema_version'] = 1
        rows[0]['teacher_action'].pop('forward')
        self.write_rows(session, rows)
        self.assertTrue(any('action forward' in error for error in dataset.validate_session(session).errors))

    def test_missing_data_root_is_reported(self):
        with self.assertRaisesRegex(ValueError, 'no session.json found'):
            list(dataset.iter_encounters(self.root / 'missing'))

    def test_malformed_rows_are_reported_with_their_location(self):
        with (self.sessions[0] / 'encounters' / 'shared.jsonl').open('a') as stream:
            stream.write('broken json\n')
        with self.assertRaisesRegex(ValueError, 'shared.jsonl:3: invalid JSON'):
            list(dataset.iter_encounters(self.root))


if __name__ == '__main__':
    unittest.main()
