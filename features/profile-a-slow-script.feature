Feature: Profile a slow script and follow the command the report names

  An agent that finds a command slow runs it under finderscope instead of
  guessing from the source. The report ranks the agent's own functions by
  the time they caused and ends with the next command to run, so the agent
  can go from "this is slow" to "this line is slow" without reading a
  profile itself.

  Scenario: the hot function is the first fix candidate, and its next command shows its lines
    Given a script whose own function spends most of the run on the CPU
    When the agent runs the script under finderscope
    Then the first fix candidate is that function
    And the report names a next command for that function
    When the agent runs the next command the report named
    Then it prints the source lines of that function, the hottest first
