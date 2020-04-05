# PL/SQL Debug (Oracle)  for Visual Studio Code

This extension allows you to debug your PL/SQL (Oracle) packages with Visual Studio Code. It uses remote debugging with the package DBMS_JDWP (Database side) and the node module JDWP with some adaptations for Oracle (vs code side).

## Database configuration

First you will have to configure your database to allow remote debugging.

You need to compile your package with PLSQL_OPTIMIZE_LEVEL = 1:

```plsql
alter session set PLSQL_OPTIMIZE_LEVEL=1;

alter package MY_PACKAGE compile body;
```

Then the user should have some rights to debug:

```plsql
GRANT DEBUG CONNECT ANY TO MY_USER;
GRANT DEBUG ANY PROCEDURE TO MY_USER;
```

An ACL needs to be created to be able to connect to the computer that runs visual studio code:

```plsql
begin
  DBMS_NETWORK_ACL_ADMIN.append_host_ace(
    host => '*'
  , ace  =>
      sys.xs$ace_type(privilege_list => sys.XS$NAME_LIST('JDWP')
                    , principal_name => 'MY_USER'
                    , principal_type => sys.XS_ACL.PTYPE_DB
                     )
  );
end;
/
```

### Custom evaluation

It's now possible to evaluate other things than the local variables. For that, the extension needs to be in a java context to be able to invoke a method (it's not possible directly in Oracle context).

I provide a [sample file](sample/evalBreakpointSample.sql) to configure the custom evaluation in your database. Then you need to provide the java class name and line in this class of the first instruction of the evalBreakpoint method in the Launch.json file (see below in extension configuration).

In your packages, you can call the procedure evalBreakpoint where you want to make some custom evaluations. The debugger will automaticlly stops on this line (you don't need to put a breakpoint on it) and when the debugguer hit this breakpoint, you can evaluate values in the debug console or watcher:

![Image of Definition](images/evaluation_sample.png)

Important: when you are in this context, local variables values are not available, as you are currently in the java virtual machine!

## Extension configuration

### Launch.json

In your project, you need to put this kind of configuraiton in launch.json file:

```json
{
  "type": "plsql",
  "request": "launch",
  "name": "Plsql Debug",
  "program": "${file}",
  "watchingSchemas": ["SCHEMA1", "SCHEMA2"],
  "socketPort": 4000
}
```

or

```json
{
  "type": "oraclesql",
  "request": "launch",
  "name": "OracleSQL Debug",
  "program": "${file}",
  "watchingSchemas": ["SCHEMA1", "SCHEMA2"],
  "socketPort": 4000
}
```

Note: watchingSchemas is very important! You need to specify all the schemas that you want to debug. When we start the debug, we put an event that will trigger on a class load. The problem is that currenctly we cannot use the '*' symbol to match several schema...

## Usage
For example: use this code to debug from sql+
```
  -- activate debug for session
  alter session set PLSQL_OPTIMIZE_LEVEL=1;
  -- activate debug from client
  EXEC DBMS_DEBUG_JDWP.CONNECT_TCP( 'localhost', '4000');
  -- excecute to debug method
  exec hr_utils.update_employee_job(100, 4, 10, 100);
  -- deactiveate debug
  EXEC DBMS_DEBUG_JDWP.DISCONNECT;
```

## Status

For the moment, it's a minimalist debugger based on the vscode-mock-debug sample.

What would be great to implement:

- [x] Watchers
- [x] On over evaluation
- [ ] For the moment, I ask the user for the source file with quick open when I don't know where the file is. Maybe it would be better to have a connection to the DB and retreive the source code?
- [ ] Find a way to evaluate more than the variables, maybe to be able to make a select [EVALUATION] from dual (with jdwp, we can invoke a method).
- [ ] Data breakpoint

## Donate

If you find this extension usefull and like it, you can make a donation to [MSF](https://www.msf.org/) and help them to fight the Covid-19. Thanks for your help and happy coding :-)

File written with Emacs and pushed with magit :stuck_out_tongue_winking_eye:
