package com.example.data;

public interface StudentGateway extends SharedRepository<Student> {
    Student findStudent(Long id);
}
