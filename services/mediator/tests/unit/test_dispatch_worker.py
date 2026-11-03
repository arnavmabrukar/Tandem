"""Worker retry and shutdown behavior without a live database."""
import unittest
from threading import Event
from unittest.mock import Mock, patch
from psycopg import OperationalError
from mediator.db.dispatch import run_dispatcher


class DispatchWorkerTests(unittest.TestCase):
    def test_database_outage_is_retried_on_next_sweep(self):
        stop = Mock()
        stop.wait.side_effect = [False, False, True]
        with patch('mediator.db.dispatch.dispatch_once', side_effect=[OperationalError(), 0]) as dispatch:
            with self.assertLogs('mediator.db.dispatch', level='WARNING'):
                run_dispatcher(stop)
        self.assertEqual(dispatch.call_count, 2)
        self.assertEqual(stop.wait.call_count, 3)

    def test_stopped_worker_never_starts_a_sweep(self):
        stop = Event()
        stop.set()
        with patch('mediator.db.dispatch.dispatch_once') as dispatch:
            run_dispatcher(stop)
        dispatch.assert_not_called()
